import type { EventEnvelope } from '@stockos/contracts';
import { INVENTORY_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

export class ThresholdAgent extends BaseAgent {
  readonly name = 'ThresholdAgent';
  readonly description = 'Monitors stock levels and triggers alerts when below thresholds';
  readonly subscribesTo = [
    INVENTORY_EVENTS.STOCK_LEVEL_CHANGED,
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      product_id: string;
      variant_id?: string;
      warehouse_id: string;
      quantity_change: number;
    };

    context.logger.info('Checking thresholds', {
      productId: payload.product_id,
      warehouseId: payload.warehouse_id,
    });

    try {
      // Get product with reorder settings
      const product = await prisma.product.findUnique({
        where: { id: payload.product_id },
        select: {
          id: true,
          sku: true,
          name: true,
          reorderPoint: true,
          safetyStock: true,
          maxStock: true,
          abcClass: true,
        },
      });

      if (!product || !product.reorderPoint) {
        return this.createSuccessResult('No threshold configured for product');
      }

      // Get total available stock for product in warehouse
      const stockLevels = await prisma.stockLevel.aggregate({
        where: {
          tenantId: context.tenantId,
          warehouseId: payload.warehouse_id,
          productId: payload.product_id,
          variantId: payload.variant_id ?? null,
        },
        _sum: {
          quantityAvailable: true,
          quantityOnHand: true,
          quantityInbound: true,
        },
      });

      const totalAvailable = stockLevels._sum.quantityAvailable ?? 0;
      const totalOnHand = stockLevels._sum.quantityOnHand ?? 0;
      const totalInbound = stockLevels._sum.quantityInbound ?? 0;

      const eventsToPublish: EventEnvelope[] = [];

      // Check if below reorder point
      if (totalAvailable <= product.reorderPoint) {
        const alertEvent = this.createLowStockAlert(
          product,
          payload.warehouse_id,
          totalAvailable,
          totalOnHand,
          totalInbound,
          event,
          context
        );
        eventsToPublish.push(alertEvent);

        context.logger.warn('Low stock alert triggered', {
          productId: product.id,
          sku: product.sku,
          available: totalAvailable,
          reorderPoint: product.reorderPoint,
        });
      }

      // Check if below safety stock (critical)
      if (product.safetyStock && totalAvailable <= product.safetyStock) {
        const criticalEvent = this.createCriticalStockAlert(
          product,
          payload.warehouse_id,
          totalAvailable,
          event,
          context
        );
        eventsToPublish.push(criticalEvent);

        context.logger.error('Critical stock level', {
          productId: product.id,
          sku: product.sku,
          available: totalAvailable,
          safetyStock: product.safetyStock,
        });
      }

      // Check if above max stock (overstock)
      if (product.maxStock && totalOnHand > product.maxStock) {
        const overstockEvent = this.createOverstockAlert(
          product,
          payload.warehouse_id,
          totalOnHand,
          event,
          context
        );
        eventsToPublish.push(overstockEvent);

        context.logger.warn('Overstock alert triggered', {
          productId: product.id,
          sku: product.sku,
          onHand: totalOnHand,
          maxStock: product.maxStock,
        });
      }

      return this.createSuccessResult(
        `Threshold check complete. ${eventsToPublish.length} alerts generated.`,
        {
          totalAvailable,
          totalOnHand,
          reorderPoint: product.reorderPoint,
          safetyStock: product.safetyStock,
          alertsGenerated: eventsToPublish.length,
        },
        eventsToPublish
      );
    } catch (error) {
      context.logger.error('Failed to check thresholds', error);
      return this.createFailureResult(
        'Failed to check thresholds',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private createLowStockAlert(
    product: { id: string; sku: string; name: string; reorderPoint: number | null },
    warehouseId: string,
    available: number,
    onHand: number,
    inbound: number,
    sourceEvent: EventEnvelope,
    context: AgentContext
  ): EventEnvelope {
    return createEvent(
      INVENTORY_EVENTS.LOW_STOCK_ALERT,
      {
        product_id: product.id,
        product_sku: product.sku,
        product_name: product.name,
        warehouse_id: warehouseId,
        quantity_available: available,
        quantity_on_hand: onHand,
        quantity_inbound: inbound,
        reorder_point: product.reorderPoint,
        suggested_reorder_qty: (product.reorderPoint ?? 0) * 2 - available,
        alert_level: 'WARNING',
      },
      {
        correlationId: context.correlationId,
        causationId: sourceEvent.event_id,
        actor: sourceEvent.actor,
        tenantId: context.tenantId,
        warehouseId,
      }
    );
  }

  private createCriticalStockAlert(
    product: { id: string; sku: string; name: string; safetyStock: number | null },
    warehouseId: string,
    available: number,
    sourceEvent: EventEnvelope,
    context: AgentContext
  ): EventEnvelope {
    return createEvent(
      INVENTORY_EVENTS.LOW_STOCK_ALERT,
      {
        product_id: product.id,
        product_sku: product.sku,
        product_name: product.name,
        warehouse_id: warehouseId,
        quantity_available: available,
        safety_stock: product.safetyStock,
        alert_level: 'CRITICAL',
      },
      {
        correlationId: context.correlationId,
        causationId: sourceEvent.event_id,
        actor: sourceEvent.actor,
        tenantId: context.tenantId,
        warehouseId,
      }
    );
  }

  private createOverstockAlert(
    product: { id: string; sku: string; name: string; maxStock: number | null },
    warehouseId: string,
    onHand: number,
    sourceEvent: EventEnvelope,
    context: AgentContext
  ): EventEnvelope {
    return createEvent(
      'OverstockAlertTriggered',
      {
        product_id: product.id,
        product_sku: product.sku,
        product_name: product.name,
        warehouse_id: warehouseId,
        quantity_on_hand: onHand,
        max_stock: product.maxStock,
        excess_quantity: onHand - (product.maxStock ?? 0),
        alert_level: 'WARNING',
      },
      {
        correlationId: context.correlationId,
        causationId: sourceEvent.event_id,
        actor: sourceEvent.actor,
        tenantId: context.tenantId,
        warehouseId,
      }
    );
  }
}
