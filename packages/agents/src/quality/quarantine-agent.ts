import type { EventEnvelope } from '@stockos/contracts';
import { INVENTORY_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

export class QuarantineAgent extends BaseAgent {
  readonly name = 'QuarantineAgent';
  readonly description = 'Manages quarantine operations for damaged or suspect inventory';
  readonly subscribesTo = [
    'QualityInspectionFailed',
    'DamageReported',
    'QuarantineRequested',
    INVENTORY_EVENTS.LOT_EXPIRED,
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      product_id: string;
      warehouse_id: string;
      lot_batch_id?: string;
      location_id?: string;
      quantity?: number;
      reason: string;
      source_event: string;
    };

    context.logger.info('Processing quarantine request', {
      productId: payload.product_id,
      reason: payload.reason,
    });

    try {
      const eventsToPublish: EventEnvelope[] = [];

      // Find quarantine location
      const quarantineLocation = await prisma.location.findFirst({
        where: {
          tenantId: context.tenantId,
          warehouseId: payload.warehouse_id,
          type: 'QUARANTINE',
          isActive: true,
        },
      });

      if (!quarantineLocation) {
        return this.createFailureResult('No quarantine location configured');
      }

      // Find stock to quarantine
      const stockLevels = await prisma.stockLevel.findMany({
        where: {
          tenantId: context.tenantId,
          warehouseId: payload.warehouse_id,
          productId: payload.product_id,
          ...(payload.lot_batch_id && { lotBatchId: payload.lot_batch_id }),
          ...(payload.location_id && { locationId: payload.location_id }),
          quantityOnHand: { gt: 0 },
        },
        include: {
          product: { select: { sku: true, name: true } },
          location: { select: { code: true } },
          lotBatch: { select: { lotNumber: true } },
        },
      });

      if (stockLevels.length === 0) {
        return this.createSuccessResult('No stock found to quarantine');
      }

      let totalQuarantined = 0;

      await prisma.$transaction(async (tx) => {
        for (const stock of stockLevels) {
          const quantityToQuarantine = payload.quantity
            ? Math.min(payload.quantity - totalQuarantined, stock.quantityOnHand)
            : stock.quantityOnHand;

          if (quantityToQuarantine <= 0) continue;

          // Check if stock is reserved
          if (stock.quantityReserved > 0) {
            // Cancel affected reservations
            const reservations = await tx.reservation.findMany({
              where: {
                stockLevelId: stock.id,
                status: 'ACTIVE',
              },
            });

            for (const res of reservations) {
              await tx.reservation.update({
                where: { id: res.id },
                data: {
                  status: 'CANCELLED',
                  quantityFulfilled: 0,
                },
              });

              eventsToPublish.push(
                createEvent(
                  'ReservationCancelled',
                  {
                    reservation_id: res.id,
                    product_id: res.productId,
                    quantity: res.quantity,
                    reason: 'QUARANTINE',
                    reference_type: res.referenceType,
                    reference_id: res.referenceId,
                  },
                  {
                    correlationId: context.correlationId,
                    causationId: event.event_id,
                    actor: event.actor,
                    tenantId: context.tenantId,
                    warehouseId: payload.warehouse_id,
                  }
                )
              );
            }
          }

          // Decrease stock at original location
          await tx.stockLevel.update({
            where: { id: stock.id },
            data: {
              quantityOnHand: { decrement: quantityToQuarantine },
              quantityAvailable: { decrement: quantityToQuarantine },
              quantityReserved: 0,
              rowVersion: { increment: 1 },
            },
          });

          // Increase stock at quarantine location
          await tx.stockLevel.upsert({
            where: {
              tenantId_warehouseId_productId_locationId_lotBatchId: {
                tenantId: context.tenantId,
                warehouseId: payload.warehouse_id,
                productId: stock.productId,
                locationId: quarantineLocation.id,
                lotBatchId: stock.lotBatchId ?? '',
              },
            },
            update: {
              quantityOnHand: { increment: quantityToQuarantine },
              quantityAvailable: { increment: quantityToQuarantine },
              rowVersion: { increment: 1 },
            },
            create: {
              tenantId: context.tenantId,
              warehouseId: payload.warehouse_id,
              productId: stock.productId,
              variantId: stock.variantId,
              locationId: quarantineLocation.id,
              lotBatchId: stock.lotBatchId,
              quantityOnHand: quantityToQuarantine,
              quantityReserved: 0,
              quantityAvailable: quantityToQuarantine,
              quantityInbound: 0,
              quantityOutbound: 0,
            },
          });

          // Record QUARANTINE_IN movement
          const movement = await tx.movement.create({
            data: {
              tenantId: context.tenantId,
              warehouseId: payload.warehouse_id,
              movementType: 'QUARANTINE_IN',
              productId: stock.productId,
              variantId: stock.variantId,
              lotBatchId: stock.lotBatchId,
              fromLocationId: stock.locationId,
              toLocationId: quarantineLocation.id,
              quantity: quantityToQuarantine,
              uom: 'UNIT',
              reasonCode: payload.reason,
              notes: `Source: ${payload.source_event}`,
              performedBy: context.userId ?? 'system',
              performedAt: new Date(),
            },
          });

          // Update lot status if applicable
          if (stock.lotBatchId) {
            await tx.lotBatch.update({
              where: { id: stock.lotBatchId },
              data: { status: 'QUARANTINE' },
            });
          }

          totalQuarantined += quantityToQuarantine;

          eventsToPublish.push(
            createEvent(
              'StockQuarantined',
              {
                movement_id: movement.id,
                product_id: stock.productId,
                product_sku: stock.product.sku,
                from_location_id: stock.locationId,
                from_location_code: stock.location.code,
                to_location_id: quarantineLocation.id,
                to_location_code: quarantineLocation.code,
                quantity: quantityToQuarantine,
                lot_batch_id: stock.lotBatchId,
                lot_number: stock.lotBatch?.lotNumber,
                reason: payload.reason,
                source_event: payload.source_event,
              },
              {
                correlationId: context.correlationId,
                causationId: event.event_id,
                actor: event.actor,
                tenantId: context.tenantId,
                warehouseId: payload.warehouse_id,
              }
            )
          );

          if (payload.quantity && totalQuarantined >= payload.quantity) break;
        }
      });

      return this.createSuccessResult(
        `Quarantined ${totalQuarantined} units of ${payload.product_id}`,
        {
          totalQuarantined,
          quarantineLocationId: quarantineLocation.id,
          quarantineLocationCode: quarantineLocation.code,
        },
        eventsToPublish
      );
    } catch (error) {
      context.logger.error('Failed to process quarantine', error);
      return this.createFailureResult(
        'Failed to process quarantine',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }
}
