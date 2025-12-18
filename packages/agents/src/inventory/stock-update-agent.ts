import type { EventEnvelope } from '@stockos/contracts';
import { INVENTORY_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma, type PrismaTransactionClient } from '@stockos/db';

export class StockUpdateAgent extends BaseAgent {
  readonly name = 'StockUpdateAgent';
  readonly description = 'Updates stock levels based on movement events';
  readonly subscribesTo = [
    INVENTORY_EVENTS.MOVEMENT_RECORDED,
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      movement_id: string;
      movement_type: string;
      product_id: string;
      variant_id?: string;
      lot_batch_id?: string;
      from_location_id?: string;
      to_location_id?: string;
      quantity: number;
      warehouse_id: string;
    };

    context.logger.info('Processing movement', {
      movementType: payload.movement_type,
      quantity: payload.quantity,
    });

    try {
      await prisma.$transaction(async (tx) => {
        await this.updateStockLevels(tx, payload, context);
      });

      // Create stock updated event
      const stockUpdatedEvent = createEvent(
        INVENTORY_EVENTS.STOCK_LEVEL_CHANGED,
        {
          product_id: payload.product_id,
          variant_id: payload.variant_id,
          warehouse_id: payload.warehouse_id,
          from_location_id: payload.from_location_id,
          to_location_id: payload.to_location_id,
          quantity_change: payload.quantity,
          movement_type: payload.movement_type,
          movement_id: payload.movement_id,
        },
        {
          correlationId: context.correlationId,
          causationId: event.event_id,
          actor: event.actor,
          tenantId: context.tenantId,
          warehouseId: payload.warehouse_id,
        }
      );

      return this.createSuccessResult(
        'Stock levels updated successfully',
        { movementId: payload.movement_id },
        [stockUpdatedEvent]
      );
    } catch (error) {
      context.logger.error('Failed to update stock levels', error);
      return this.createFailureResult(
        'Failed to update stock levels',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async updateStockLevels(
    tx: PrismaTransactionClient,
    payload: {
      movement_type: string;
      product_id: string;
      variant_id?: string;
      lot_batch_id?: string;
      from_location_id?: string;
      to_location_id?: string;
      quantity: number;
      warehouse_id: string;
    },
    context: AgentContext
  ): Promise<void> {
    const { movement_type, quantity } = payload;

    // Determine stock changes based on movement type
    const effect = this.getMovementEffect(movement_type);

    // Update source location (decrease)
    if (effect.decreasesSource && payload.from_location_id) {
      await this.adjustStockLevel(
        tx,
        context.tenantId,
        payload.warehouse_id,
        payload.product_id,
        payload.from_location_id,
        payload.variant_id,
        payload.lot_batch_id,
        -quantity
      );
    }

    // Update destination location (increase)
    if (effect.increasesDestination && payload.to_location_id) {
      await this.adjustStockLevel(
        tx,
        context.tenantId,
        payload.warehouse_id,
        payload.product_id,
        payload.to_location_id,
        payload.variant_id,
        payload.lot_batch_id,
        quantity
      );
    }
  }

  private getMovementEffect(movementType: string): {
    decreasesSource: boolean;
    increasesDestination: boolean;
  } {
    switch (movementType) {
      case 'RECEIPT':
      case 'TRANSFER_IN':
      case 'RETURN':
      case 'ADJUSTMENT_PLUS':
      case 'QUARANTINE_OUT':
        return { decreasesSource: false, increasesDestination: true };

      case 'SHIP':
      case 'TRANSFER_OUT':
      case 'DAMAGE':
      case 'EXPIRED':
      case 'ADJUSTMENT_MINUS':
      case 'SCRAP':
      case 'CONSUME':
      case 'QUARANTINE_IN':
        return { decreasesSource: true, increasesDestination: false };

      case 'PUTAWAY':
      case 'PICK':
      case 'PACK':
        return { decreasesSource: true, increasesDestination: true };

      default:
        return { decreasesSource: false, increasesDestination: false };
    }
  }

  private async adjustStockLevel(
    tx: PrismaTransactionClient,
    tenantId: string,
    warehouseId: string,
    productId: string,
    locationId: string,
    variantId: string | undefined,
    lotBatchId: string | undefined,
    delta: number
  ): Promise<void> {
    // Try to find existing stock level
    const existing = await tx.stockLevel.findFirst({
      where: {
        tenantId,
        warehouseId,
        productId,
        locationId,
        variantId: variantId ?? null,
        lotBatchId: lotBatchId ?? null,
      },
    });

    if (existing) {
      const newOnHand = existing.quantityOnHand + delta;
      const newAvailable = newOnHand - existing.quantityReserved;

      await tx.stockLevel.update({
        where: { id: existing.id },
        data: {
          quantityOnHand: newOnHand,
          quantityAvailable: newAvailable,
          lastMovementAt: new Date(),
          rowVersion: { increment: 1 },
        },
      });
    } else if (delta > 0) {
      // Create new stock level only for positive adjustments
      await tx.stockLevel.create({
        data: {
          tenantId,
          warehouseId,
          productId,
          variantId,
          locationId,
          lotBatchId,
          quantityOnHand: delta,
          quantityReserved: 0,
          quantityAvailable: delta,
          quantityInbound: 0,
          quantityOutbound: 0,
          lastMovementAt: new Date(),
        },
      });
    }
  }
}
