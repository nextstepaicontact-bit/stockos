import type { EventEnvelope } from '@stockos/contracts';
import { createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

export class PackingAgent extends BaseAgent {
  readonly name = 'PackingAgent';
  readonly description = 'Manages packing operations and suggests optimal packaging';
  readonly subscribesTo = [
    'PickWaveCompleted',
    'PackingRequested',
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      wave_id?: string;
      order_id: string;
      warehouse_id: string;
      picked_items: Array<{
        product_id: string;
        quantity: number;
        lot_batch_id?: string;
      }>;
    };

    context.logger.info('Processing packing request', {
      orderId: payload.order_id,
      itemCount: payload.picked_items.length,
    });

    try {
      // Get order details
      const order = await prisma.salesOrder.findUnique({
        where: { id: payload.order_id },
        include: {
          lines: {
            include: {
              product: {
                select: {
                  sku: true,
                  name: true,
                  weight: true,
                  length: true,
                  width: true,
                  height: true,
                  volume: true,
                },
              },
            },
          },
        },
      });

      if (!order) {
        return this.createFailureResult('Order not found');
      }

      // Calculate packaging requirements
      const packingResult = this.calculatePacking(
        payload.picked_items.map(item => {
          const line = order.lines.find(l => l.productId === item.product_id);
          return {
            productId: item.product_id,
            quantity: item.quantity,
            weight: line?.product.weight ? Number(line.product.weight) : 0.5,
            volume: line?.product.volume ? Number(line.product.volume) : 0.001,
            dimensions: line?.product.length
              ? {
                  length: Number(line.product.length),
                  width: Number(line.product.width ?? 1),
                  height: Number(line.product.height ?? 1),
                }
              : undefined,
          };
        })
      );

      // Create packing event
      const packingEvent = createEvent(
        'PackingInstructionsGenerated',
        {
          order_id: payload.order_id,
          warehouse_id: payload.warehouse_id,
          wave_id: payload.wave_id,
          shipping_method: order.shippingMethod,
          total_items: payload.picked_items.reduce((sum, i) => sum + i.quantity, 0),
          total_weight_kg: packingResult.totalWeight,
          total_volume_m3: packingResult.totalVolume,
          suggested_packages: packingResult.packages,
          packing_instructions: packingResult.instructions,
          special_handling: packingResult.specialHandling,
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
        `Generated packing instructions for ${packingResult.packages.length} package(s)`,
        {
          packageCount: packingResult.packages.length,
          totalWeight: packingResult.totalWeight,
        },
        [packingEvent]
      );
    } catch (error) {
      context.logger.error('Failed to process packing', error);
      return this.createFailureResult(
        'Failed to process packing',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private calculatePacking(items: Array<{
    productId: string;
    quantity: number;
    weight: number;
    volume: number;
    dimensions?: { length: number; width: number; height: number };
  }>): {
    totalWeight: number;
    totalVolume: number;
    packages: Array<{
      packageType: string;
      dimensions: { length: number; width: number; height: number };
      maxWeight: number;
      items: string[];
    }>;
    instructions: string[];
    specialHandling: string[];
  } {
    const totalWeight = items.reduce(
      (sum, item) => sum + item.weight * item.quantity,
      0
    );
    const totalVolume = items.reduce(
      (sum, item) => sum + item.volume * item.quantity,
      0
    );

    // Simple bin packing - would be more sophisticated in production
    const packages: Array<{
      packageType: string;
      dimensions: { length: number; width: number; height: number };
      maxWeight: number;
      items: string[];
    }> = [];

    const instructions: string[] = [];
    const specialHandling: string[] = [];

    // Determine package type based on total volume and weight
    if (totalVolume <= 0.01 && totalWeight <= 2) {
      packages.push({
        packageType: 'SMALL_BOX',
        dimensions: { length: 30, width: 20, height: 15 },
        maxWeight: 5,
        items: items.map(i => i.productId),
      });
      instructions.push('Use small box with appropriate padding');
    } else if (totalVolume <= 0.05 && totalWeight <= 10) {
      packages.push({
        packageType: 'MEDIUM_BOX',
        dimensions: { length: 45, width: 35, height: 25 },
        maxWeight: 15,
        items: items.map(i => i.productId),
      });
      instructions.push('Use medium box with bubble wrap protection');
    } else if (totalVolume <= 0.15 && totalWeight <= 25) {
      packages.push({
        packageType: 'LARGE_BOX',
        dimensions: { length: 60, width: 45, height: 40 },
        maxWeight: 30,
        items: items.map(i => i.productId),
      });
      instructions.push('Use large box with corner protectors');
    } else {
      // Split into multiple packages
      let remainingWeight = totalWeight;
      let packageNum = 1;

      while (remainingWeight > 0) {
        const packageWeight = Math.min(remainingWeight, 25);
        packages.push({
          packageType: 'LARGE_BOX',
          dimensions: { length: 60, width: 45, height: 40 },
          maxWeight: 30,
          items: [`Package ${packageNum} items`],
        });
        remainingWeight -= packageWeight;
        packageNum++;
      }
      instructions.push(`Split shipment into ${packages.length} packages`);
      specialHandling.push('MULTI_PACKAGE_SHIPMENT');
    }

    // Add weight-based handling
    if (totalWeight > 15) {
      specialHandling.push('HEAVY_PACKAGE');
      instructions.push('Apply HEAVY label');
    }

    instructions.push('Include packing slip inside first package');
    instructions.push('Apply shipping label on largest flat surface');

    return {
      totalWeight: Math.round(totalWeight * 100) / 100,
      totalVolume: Math.round(totalVolume * 1000) / 1000,
      packages,
      instructions,
      specialHandling,
    };
  }
}
