import type { EventEnvelope } from '@stockos/contracts';
import { SALES_ORDER_EVENTS, INVENTORY_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

export class ShippingAgent extends BaseAgent {
  readonly name = 'ShippingAgent';
  readonly description = 'Handles shipping confirmations and updates order/inventory status';
  readonly subscribesTo = [
    'PackingCompleted',
    'ShipmentRequested',
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      order_id: string;
      warehouse_id: string;
      packages: Array<{
        package_id: string;
        tracking_number?: string;
        carrier: string;
        weight_kg: number;
        items: Array<{
          product_id: string;
          quantity: number;
          lot_batch_id?: string;
        }>;
      }>;
    };

    context.logger.info('Processing shipment', {
      orderId: payload.order_id,
      packageCount: payload.packages.length,
    });

    try {
      const eventsToPublish: EventEnvelope[] = [];

      await prisma.$transaction(async (tx) => {
        // Update order status
        await tx.salesOrder.update({
          where: { id: payload.order_id },
          data: {
            status: 'SHIPPED',
            shippedDate: new Date(),
          },
        });

        // Process each package
        for (const pkg of payload.packages) {
          for (const item of pkg.items) {
            // Find and fulfill reservations
            const reservations = await tx.reservation.findMany({
              where: {
                referenceType: 'SalesOrder',
                referenceId: payload.order_id,
                productId: item.product_id,
                status: 'ACTIVE',
              },
            });

            let remainingQty = item.quantity;

            for (const res of reservations) {
              if (remainingQty <= 0) break;

              const fulfillQty = Math.min(
                remainingQty,
                res.quantity - res.quantityFulfilled
              );

              // Update reservation
              const newFulfilled = res.quantityFulfilled + fulfillQty;
              await tx.reservation.update({
                where: { id: res.id },
                data: {
                  quantityFulfilled: newFulfilled,
                  status: newFulfilled >= res.quantity ? 'FULFILLED' : 'ACTIVE',
                },
              });

              // Update stock level
              if (res.stockLevelId) {
                await tx.stockLevel.update({
                  where: { id: res.stockLevelId },
                  data: {
                    quantityOnHand: { decrement: fulfillQty },
                    quantityReserved: { decrement: fulfillQty },
                    rowVersion: { increment: 1 },
                  },
                });
              }

              // Record movement
              const movement = await tx.movement.create({
                data: {
                  tenantId: context.tenantId,
                  warehouseId: payload.warehouse_id,
                  movementType: 'SHIP',
                  productId: item.product_id,
                  lotBatchId: item.lot_batch_id,
                  fromLocationId: res.stockLevelId
                    ? (
                        await tx.stockLevel.findUnique({
                          where: { id: res.stockLevelId },
                        })
                      )?.locationId
                    : undefined,
                  quantity: fulfillQty,
                  uom: 'UNIT',
                  referenceType: 'SalesOrder',
                  referenceId: payload.order_id,
                  reasonCode: 'SHIPMENT',
                  performedBy: context.userId ?? 'system',
                  performedAt: new Date(),
                },
              });

              // Create movement event
              eventsToPublish.push(
                createEvent(
                  INVENTORY_EVENTS.MOVEMENT_RECORDED,
                  {
                    movement_id: movement.id,
                    movement_type: 'SHIP',
                    product_id: item.product_id,
                    warehouse_id: payload.warehouse_id,
                    from_location_id: movement.fromLocationId,
                    quantity: fulfillQty,
                    reference_type: 'SalesOrder',
                    reference_id: payload.order_id,
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

              remainingQty -= fulfillQty;
            }

            // Update order line
            await tx.salesOrderLine.updateMany({
              where: {
                salesOrderId: payload.order_id,
                productId: item.product_id,
              },
              data: {
                quantityShipped: { increment: item.quantity },
                status: 'SHIPPED',
              },
            });
          }
        }
      });

      // Create order shipped event
      eventsToPublish.push(
        createEvent(
          SALES_ORDER_EVENTS.ORDER_SHIPPED,
          {
            order_id: payload.order_id,
            warehouse_id: payload.warehouse_id,
            shipped_at: new Date().toISOString(),
            package_count: payload.packages.length,
            packages: payload.packages.map(pkg => ({
              package_id: pkg.package_id,
              tracking_number: pkg.tracking_number,
              carrier: pkg.carrier,
              weight_kg: pkg.weight_kg,
            })),
            total_items_shipped: payload.packages.reduce(
              (sum, pkg) => sum + pkg.items.reduce((s, i) => s + i.quantity, 0),
              0
            ),
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

      return this.createSuccessResult(
        `Shipped ${payload.packages.length} packages for order ${payload.order_id}`,
        {
          orderId: payload.order_id,
          packageCount: payload.packages.length,
          trackingNumbers: payload.packages
            .filter(p => p.tracking_number)
            .map(p => p.tracking_number),
        },
        eventsToPublish
      );
    } catch (error) {
      context.logger.error('Failed to process shipment', error);
      return this.createFailureResult(
        'Failed to process shipment',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }
}
