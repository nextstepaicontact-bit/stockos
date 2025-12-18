import type { EventEnvelope } from '@stockos/contracts';
import { INVENTORY_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

export class LotExpiryAgent extends BaseAgent {
  readonly name = 'LotExpiryAgent';
  readonly description = 'Monitors lot expiration dates and triggers alerts/actions';
  readonly subscribesTo = [
    'ScheduledExpiryCheck', // Triggered by cron job
    INVENTORY_EVENTS.STOCK_LEVEL_CHANGED,
  ];

  // Configurable thresholds (days before expiration)
  private readonly warningThreshold = 30;
  private readonly criticalThreshold = 7;
  private readonly expiredThreshold = 0;

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      warehouse_id?: string;
      product_id?: string;
      check_type?: 'FULL' | 'INCREMENTAL';
    };

    context.logger.info('Running lot expiry check', {
      warehouseId: payload.warehouse_id,
      productId: payload.product_id,
      checkType: payload.check_type ?? 'FULL',
    });

    try {
      const now = new Date();
      const warningDate = new Date(now.getTime() + this.warningThreshold * 24 * 60 * 60 * 1000);
      const criticalDate = new Date(now.getTime() + this.criticalThreshold * 24 * 60 * 60 * 1000);

      // Find lots expiring soon or already expired
      const expiringLots = await prisma.lotBatch.findMany({
        where: {
          tenantId: context.tenantId,
          expirationDate: { lte: warningDate },
          status: { in: ['AVAILABLE', 'RELEASED'] },
          ...(payload.product_id && { productId: payload.product_id }),
        },
        include: {
          product: {
            select: { sku: true, name: true },
          },
          stockLevels: {
            where: {
              quantityOnHand: { gt: 0 },
              ...(payload.warehouse_id && { warehouseId: payload.warehouse_id }),
            },
            select: {
              id: true,
              warehouseId: true,
              locationId: true,
              quantityOnHand: true,
              quantityReserved: true,
            },
          },
        },
      });

      const eventsToPublish: EventEnvelope[] = [];
      const summary = {
        expired: [] as string[],
        critical: [] as string[],
        warning: [] as string[],
        autoQuarantined: 0,
      };

      for (const lot of expiringLots) {
        if (!lot.expirationDate || lot.stockLevels.length === 0) continue;

        const daysToExpiry = Math.ceil(
          (lot.expirationDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
        );

        const totalQuantity = lot.stockLevels.reduce(
          (sum, sl) => sum + sl.quantityOnHand,
          0
        );

        // Already expired
        if (daysToExpiry <= this.expiredThreshold) {
          summary.expired.push(lot.lotNumber);

          // Auto-quarantine expired lots
          await this.quarantineExpiredLot(lot.id, context);
          summary.autoQuarantined++;

          eventsToPublish.push(
            createEvent(
              INVENTORY_EVENTS.LOT_EXPIRED,
              {
                lot_batch_id: lot.id,
                lot_number: lot.lotNumber,
                product_id: lot.productId,
                product_sku: lot.product.sku,
                product_name: lot.product.name,
                expiration_date: lot.expirationDate.toISOString(),
                days_expired: Math.abs(daysToExpiry),
                total_quantity: totalQuantity,
                locations: lot.stockLevels.map(sl => ({
                  warehouse_id: sl.warehouseId,
                  location_id: sl.locationId,
                  quantity: sl.quantityOnHand,
                })),
                action_taken: 'AUTO_QUARANTINE',
              },
              {
                correlationId: context.correlationId,
                causationId: event.event_id,
                actor: event.actor,
                tenantId: context.tenantId,
              }
            )
          );
        }
        // Critical (< 7 days)
        else if (daysToExpiry <= this.criticalThreshold) {
          summary.critical.push(lot.lotNumber);

          eventsToPublish.push(
            createEvent(
              'LotExpiryAlert',
              {
                lot_batch_id: lot.id,
                lot_number: lot.lotNumber,
                product_id: lot.productId,
                product_sku: lot.product.sku,
                product_name: lot.product.name,
                expiration_date: lot.expirationDate.toISOString(),
                days_to_expiry: daysToExpiry,
                total_quantity: totalQuantity,
                alert_level: 'CRITICAL',
                recommended_action: 'IMMEDIATE_SALE_OR_DISPOSAL',
              },
              {
                correlationId: context.correlationId,
                causationId: event.event_id,
                actor: event.actor,
                tenantId: context.tenantId,
              }
            )
          );
        }
        // Warning (< 30 days)
        else {
          summary.warning.push(lot.lotNumber);

          eventsToPublish.push(
            createEvent(
              'LotExpiryAlert',
              {
                lot_batch_id: lot.id,
                lot_number: lot.lotNumber,
                product_id: lot.productId,
                product_sku: lot.product.sku,
                product_name: lot.product.name,
                expiration_date: lot.expirationDate.toISOString(),
                days_to_expiry: daysToExpiry,
                total_quantity: totalQuantity,
                alert_level: 'WARNING',
                recommended_action: 'PRIORITIZE_FOR_SALE',
              },
              {
                correlationId: context.correlationId,
                causationId: event.event_id,
                actor: event.actor,
                tenantId: context.tenantId,
              }
            )
          );
        }
      }

      context.logger.info('Lot expiry check complete', {
        expired: summary.expired.length,
        critical: summary.critical.length,
        warning: summary.warning.length,
        autoQuarantined: summary.autoQuarantined,
      });

      return this.createSuccessResult(
        `Expiry check complete: ${summary.expired.length} expired, ${summary.critical.length} critical, ${summary.warning.length} warning`,
        summary,
        eventsToPublish
      );
    } catch (error) {
      context.logger.error('Failed to run lot expiry check', error);
      return this.createFailureResult(
        'Failed to run lot expiry check',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async quarantineExpiredLot(
    lotBatchId: string,
    context: AgentContext
  ): Promise<void> {
    await prisma.lotBatch.update({
      where: { id: lotBatchId },
      data: {
        status: 'EXPIRED',
        metadata: {
          expired_at: new Date().toISOString(),
          quarantined_by: 'LotExpiryAgent',
          correlation_id: context.correlationId,
        },
      },
    });

    context.logger.info('Auto-quarantined expired lot', { lotBatchId });
  }
}
