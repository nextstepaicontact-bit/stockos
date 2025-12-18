import type { EventEnvelope } from '@stockos/contracts';
import { SALES_ORDER_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

interface PickTask {
  id: string;
  orderId: string;
  orderLineId: string;
  productId: string;
  productSku: string;
  locationId: string;
  locationCode: string;
  zone: string;
  pickSequence: number;
  quantity: number;
  lotBatchId?: string;
  lotNumber?: string;
}

export class PickWaveAgent extends BaseAgent {
  readonly name = 'PickWaveAgent';
  readonly description = 'Creates optimized pick waves from allocated orders';
  readonly subscribesTo = [
    SALES_ORDER_EVENTS.ORDER_FULLY_ALLOCATED,
    'PickWaveRequested',
  ];

  private readonly maxTasksPerWave = 50;
  private readonly maxOrdersPerWave = 10;

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      order_id?: string;
      warehouse_id: string;
      wave_type?: 'SINGLE_ORDER' | 'BATCH' | 'ZONE';
    };

    const waveType = payload.wave_type ?? 'BATCH';

    context.logger.info('Creating pick wave', {
      warehouseId: payload.warehouse_id,
      orderId: payload.order_id,
      waveType,
    });

    try {
      let pickTasks: PickTask[];

      if (payload.order_id) {
        // Single order wave
        pickTasks = await this.getTasksForOrder(
          context.tenantId,
          payload.warehouse_id,
          payload.order_id
        );
      } else {
        // Batch wave - get multiple pending orders
        pickTasks = await this.getTasksForBatchWave(
          context.tenantId,
          payload.warehouse_id
        );
      }

      if (pickTasks.length === 0) {
        return this.createSuccessResult('No pick tasks to create');
      }

      // Optimize pick sequence (sort by zone, then pick sequence)
      pickTasks.sort((a, b) => {
        if (a.zone !== b.zone) return a.zone.localeCompare(b.zone);
        return a.pickSequence - b.pickSequence;
      });

      // Group into waves
      const waves = this.groupIntoWaves(pickTasks, waveType);

      const eventsToPublish: EventEnvelope[] = [];

      for (const wave of waves) {
        const waveEvent = createEvent(
          'PickWaveCreated',
          {
            wave_id: wave.id,
            warehouse_id: payload.warehouse_id,
            wave_type: waveType,
            total_tasks: wave.tasks.length,
            total_quantity: wave.tasks.reduce((sum, t) => sum + t.quantity, 0),
            order_count: new Set(wave.tasks.map(t => t.orderId)).size,
            zones: [...new Set(wave.tasks.map(t => t.zone))],
            estimated_time_minutes: this.estimatePickTime(wave.tasks),
            tasks: wave.tasks.map(t => ({
              task_id: t.id,
              order_id: t.orderId,
              order_line_id: t.orderLineId,
              product_id: t.productId,
              product_sku: t.productSku,
              location_id: t.locationId,
              location_code: t.locationCode,
              quantity: t.quantity,
              lot_batch_id: t.lotBatchId,
              lot_number: t.lotNumber,
              sequence: wave.tasks.indexOf(t) + 1,
            })),
          },
          {
            correlationId: context.correlationId,
            causationId: event.event_id,
            actor: event.actor,
            tenantId: context.tenantId,
            warehouseId: payload.warehouse_id,
          }
        );
        eventsToPublish.push(waveEvent);
      }

      return this.createSuccessResult(
        `Created ${waves.length} pick wave(s) with ${pickTasks.length} tasks`,
        {
          waveCount: waves.length,
          totalTasks: pickTasks.length,
          orderCount: new Set(pickTasks.map(t => t.orderId)).size,
        },
        eventsToPublish
      );
    } catch (error) {
      context.logger.error('Failed to create pick wave', error);
      return this.createFailureResult(
        'Failed to create pick wave',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async getTasksForOrder(
    tenantId: string,
    warehouseId: string,
    orderId: string
  ): Promise<PickTask[]> {
    const reservations = await prisma.reservation.findMany({
      where: {
        tenantId,
        warehouseId,
        referenceType: 'SalesOrder',
        referenceId: orderId,
        status: 'ACTIVE',
      },
      include: {
        product: { select: { sku: true } },
        lotBatch: { select: { lotNumber: true } },
      },
    });

    const tasks: PickTask[] = [];

    for (const res of reservations) {
      // Get stock level with location
      const stockLevel = res.stockLevelId
        ? await prisma.stockLevel.findUnique({
            where: { id: res.stockLevelId },
            include: { location: true },
          })
        : null;

      if (stockLevel?.location) {
        tasks.push({
          id: `PICK-${res.id}`,
          orderId: res.referenceId,
          orderLineId: res.referenceLineId ?? res.referenceId,
          productId: res.productId,
          productSku: res.product.sku,
          locationId: stockLevel.locationId,
          locationCode: stockLevel.location.code,
          zone: stockLevel.location.zone,
          pickSequence: stockLevel.location.pickSequence ?? 999,
          quantity: res.quantity - res.quantityFulfilled,
          lotBatchId: res.lotBatchId ?? undefined,
          lotNumber: res.lotBatch?.lotNumber,
        });
      }
    }

    return tasks;
  }

  private async getTasksForBatchWave(
    tenantId: string,
    warehouseId: string
  ): Promise<PickTask[]> {
    // Get orders that are fully allocated but not yet in a wave
    const orders = await prisma.salesOrder.findMany({
      where: {
        tenantId,
        status: 'ALLOCATED',
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: this.maxOrdersPerWave,
      select: { id: true },
    });

    const allTasks: PickTask[] = [];

    for (const order of orders) {
      const orderTasks = await this.getTasksForOrder(
        tenantId,
        warehouseId,
        order.id
      );
      allTasks.push(...orderTasks);

      if (allTasks.length >= this.maxTasksPerWave) break;
    }

    return allTasks.slice(0, this.maxTasksPerWave);
  }

  private groupIntoWaves(
    tasks: PickTask[],
    waveType: string
  ): Array<{ id: string; tasks: PickTask[] }> {
    if (waveType === 'SINGLE_ORDER') {
      // One wave per order
      const orderGroups = new Map<string, PickTask[]>();
      for (const task of tasks) {
        const existing = orderGroups.get(task.orderId) ?? [];
        existing.push(task);
        orderGroups.set(task.orderId, existing);
      }

      return Array.from(orderGroups.entries()).map(([orderId, orderTasks]) => ({
        id: `WAVE-${orderId}-${Date.now()}`,
        tasks: orderTasks,
      }));
    }

    if (waveType === 'ZONE') {
      // One wave per zone
      const zoneGroups = new Map<string, PickTask[]>();
      for (const task of tasks) {
        const existing = zoneGroups.get(task.zone) ?? [];
        existing.push(task);
        zoneGroups.set(task.zone, existing);
      }

      return Array.from(zoneGroups.entries()).map(([zone, zoneTasks]) => ({
        id: `WAVE-${zone}-${Date.now()}`,
        tasks: zoneTasks,
      }));
    }

    // Default: batch all together
    return [
      {
        id: `WAVE-BATCH-${Date.now()}`,
        tasks,
      },
    ];
  }

  private estimatePickTime(tasks: PickTask[]): number {
    // Simple estimation: 30 seconds per pick + 10 seconds per zone change
    const pickTime = tasks.length * 0.5; // minutes
    const zones = new Set(tasks.map(t => t.zone));
    const zoneChangeTime = (zones.size - 1) * (10 / 60); // minutes
    return Math.ceil(pickTime + zoneChangeTime);
  }
}
