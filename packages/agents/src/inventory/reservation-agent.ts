import type { EventEnvelope } from '@stockos/contracts';
import { SALES_ORDER_EVENTS, INVENTORY_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';
import { allocateWithFefo, type AllocationRequest, type InventorySource } from '@stockos/domain/rules';

export class ReservationAgent extends BaseAgent {
  readonly name = 'ReservationAgent';
  readonly description = 'Handles stock reservations for orders using FEFO allocation';
  readonly subscribesTo = [
    SALES_ORDER_EVENTS.ORDER_PLACED,
    'ReservationRequested',
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      order_id: string;
      warehouse_id: string;
      lines: Array<{
        line_id: string;
        product_id: string;
        variant_id?: string;
        quantity: number;
      }>;
    };

    context.logger.info('Processing reservations for order', {
      orderId: payload.order_id,
      lineCount: payload.lines.length,
    });

    try {
      const reservationResults: Array<{
        lineId: string;
        productId: string;
        requestedQty: number;
        reservedQty: number;
        fullyReserved: boolean;
        allocations: Array<{
          stockLevelId: string;
          locationId: string;
          lotBatchId?: string;
          quantity: number;
        }>;
      }> = [];

      const eventsToPublish: EventEnvelope[] = [];

      await prisma.$transaction(async (tx) => {
        for (const line of payload.lines) {
          const result = await this.reserveForLine(
            tx,
            context.tenantId,
            payload.warehouse_id,
            payload.order_id,
            line,
            context
          );

          reservationResults.push(result);

          // Create reservation event for each line
          const reservationEvent = createEvent(
            INVENTORY_EVENTS.STOCK_RESERVED,
            {
              order_id: payload.order_id,
              order_line_id: line.line_id,
              product_id: line.product_id,
              variant_id: line.variant_id,
              warehouse_id: payload.warehouse_id,
              requested_quantity: line.quantity,
              reserved_quantity: result.reservedQty,
              fully_reserved: result.fullyReserved,
              allocations: result.allocations,
            },
            {
              correlationId: context.correlationId,
              causationId: event.event_id,
              actor: event.actor,
              tenantId: context.tenantId,
              warehouseId: payload.warehouse_id,
            }
          );
          eventsToPublish.push(reservationEvent);
        }
      });

      const totalRequested = payload.lines.reduce((sum, l) => sum + l.quantity, 0);
      const totalReserved = reservationResults.reduce((sum, r) => sum + r.reservedQty, 0);
      const allFullyReserved = reservationResults.every(r => r.fullyReserved);

      // Create order-level event
      if (allFullyReserved) {
        eventsToPublish.push(
          createEvent(
            SALES_ORDER_EVENTS.ORDER_FULLY_ALLOCATED,
            {
              order_id: payload.order_id,
              warehouse_id: payload.warehouse_id,
              total_lines: payload.lines.length,
              total_quantity_reserved: totalReserved,
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
      } else {
        eventsToPublish.push(
          createEvent(
            SALES_ORDER_EVENTS.ORDER_PARTIALLY_ALLOCATED,
            {
              order_id: payload.order_id,
              warehouse_id: payload.warehouse_id,
              total_requested: totalRequested,
              total_reserved: totalReserved,
              shortfall: totalRequested - totalReserved,
              partially_reserved_lines: reservationResults
                .filter(r => !r.fullyReserved)
                .map(r => ({
                  line_id: r.lineId,
                  product_id: r.productId,
                  requested: r.requestedQty,
                  reserved: r.reservedQty,
                })),
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

      return this.createSuccessResult(
        `Reserved ${totalReserved}/${totalRequested} units for ${payload.lines.length} lines`,
        {
          orderId: payload.order_id,
          totalRequested,
          totalReserved,
          allFullyReserved,
          lineResults: reservationResults,
        },
        eventsToPublish
      );
    } catch (error) {
      context.logger.error('Failed to process reservations', error);
      return this.createFailureResult(
        'Failed to process reservations',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async reserveForLine(
    tx: typeof prisma,
    tenantId: string,
    warehouseId: string,
    orderId: string,
    line: {
      line_id: string;
      product_id: string;
      variant_id?: string;
      quantity: number;
    },
    context: AgentContext
  ): Promise<{
    lineId: string;
    productId: string;
    requestedQty: number;
    reservedQty: number;
    fullyReserved: boolean;
    allocations: Array<{
      stockLevelId: string;
      locationId: string;
      lotBatchId?: string;
      quantity: number;
    }>;
  }> {
    // Get available stock with lot information
    const stockLevels = await tx.stockLevel.findMany({
      where: {
        tenantId,
        warehouseId,
        productId: line.product_id,
        variantId: line.variant_id ?? null,
        quantityAvailable: { gt: 0 },
      },
      include: {
        lotBatch: true,
        location: true,
      },
    });

    // Build inventory sources for FEFO allocator
    const sources: InventorySource[] = stockLevels.map(sl => ({
      stockLevel: {
        id: sl.id,
        tenantId: sl.tenantId,
        warehouseId: sl.warehouseId,
        productId: sl.productId,
        variantId: sl.variantId ?? undefined,
        locationId: sl.locationId,
        lotBatchId: sl.lotBatchId ?? undefined,
        quantityOnHand: sl.quantityOnHand,
        quantityReserved: sl.quantityReserved,
        quantityAvailable: sl.quantityAvailable,
        quantityInbound: sl.quantityInbound,
        quantityOutbound: sl.quantityOutbound,
        lastMovementAt: sl.lastMovementAt ?? undefined,
        rowVersion: sl.rowVersion,
        createdAt: sl.createdAt,
        updatedAt: sl.updatedAt,
      },
      lotBatch: sl.lotBatch
        ? {
            id: sl.lotBatch.id,
            tenantId: sl.lotBatch.tenantId,
            productId: sl.lotBatch.productId,
            lotNumber: sl.lotBatch.lotNumber,
            batchNumber: sl.lotBatch.batchNumber ?? undefined,
            expirationDate: sl.lotBatch.expirationDate ?? undefined,
            manufactureDate: sl.lotBatch.manufactureDate ?? undefined,
            receivedAt: sl.lotBatch.receivedAt,
            supplierId: sl.lotBatch.supplierId ?? undefined,
            status: sl.lotBatch.status as 'AVAILABLE' | 'QUARANTINE' | 'EXPIRED' | 'HOLD' | 'RELEASED',
            certificateOfAnalysis: sl.lotBatch.certificateOfAnalysis ?? undefined,
            createdAt: sl.lotBatch.createdAt,
            updatedAt: sl.lotBatch.updatedAt,
          }
        : undefined,
    }));

    // Build allocation request
    const request: AllocationRequest = {
      productId: line.product_id,
      variantId: line.variant_id,
      requestedQuantity: line.quantity,
      warehouseId,
      referenceType: 'SalesOrder',
      referenceId: orderId,
      minDaysToExpiration: 7, // Don't allocate items expiring within 7 days
    };

    // Allocate using FEFO
    const allocation = allocateWithFefo(request, sources);

    // Create reservations and update stock levels
    const allocations: Array<{
      stockLevelId: string;
      locationId: string;
      lotBatchId?: string;
      quantity: number;
    }> = [];

    for (const alloc of allocation.allocations) {
      // Update stock level to increase reserved quantity
      await tx.stockLevel.update({
        where: { id: alloc.stockLevelId },
        data: {
          quantityReserved: { increment: alloc.quantity },
          quantityAvailable: { decrement: alloc.quantity },
          rowVersion: { increment: 1 },
        },
      });

      // Create reservation record
      await tx.reservation.create({
        data: {
          tenantId,
          warehouseId,
          productId: line.product_id,
          variantId: line.variant_id,
          stockLevelId: alloc.stockLevelId,
          lotBatchId: alloc.lotBatchId,
          quantity: alloc.quantity,
          quantityFulfilled: 0,
          referenceType: 'SalesOrder',
          referenceId: orderId,
          referenceLineId: line.line_id,
          status: 'ACTIVE',
          createdBy: context.userId ?? 'system',
        },
      });

      allocations.push({
        stockLevelId: alloc.stockLevelId,
        locationId: alloc.locationId,
        lotBatchId: alloc.lotBatchId,
        quantity: alloc.quantity,
      });
    }

    return {
      lineId: line.line_id,
      productId: line.product_id,
      requestedQty: line.quantity,
      reservedQty: allocation.allocatedQuantity,
      fullyReserved: allocation.fullyAllocated,
      allocations,
    };
  }
}
