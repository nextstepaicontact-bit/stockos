import type { EventEnvelope } from '@stockos/contracts';
import { RECEIVING_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

export class QualityControlAgent extends BaseAgent {
  readonly name = 'QualityControlAgent';
  readonly description = 'Manages quality control inspections for received goods';
  readonly subscribesTo = [
    RECEIVING_EVENTS.GOODS_RECEIVED,
    'QualityInspectionRequested',
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      receipt_id: string;
      warehouse_id: string;
      quality_check_required: boolean;
      lines: Array<{
        line_id: string;
        product_id: string;
        quantity_received: number;
        lot_number?: string;
        lot_batch_id?: string;
      }>;
    };

    if (!payload.quality_check_required) {
      return this.createSuccessResult('No quality check required');
    }

    context.logger.info('Creating quality inspection tasks', {
      receiptId: payload.receipt_id,
      lineCount: payload.lines.length,
    });

    try {
      const inspectionTasks: Array<{
        taskId: string;
        lineId: string;
        productId: string;
        productSku: string;
        quantity: number;
        lotNumber?: string;
        inspectionType: string;
        criteria: string[];
      }> = [];

      for (const line of payload.lines) {
        // Get product details for inspection criteria
        const product = await prisma.product.findUnique({
          where: { id: line.product_id },
          select: {
            sku: true,
            name: true,
            isHazmat: true,
            temperatureRequired: true,
            shelfLifeDays: true,
            isLotTracked: true,
          },
        });

        if (!product) continue;

        // Determine inspection criteria based on product attributes
        const criteria = this.determineInspectionCriteria(product, line);

        inspectionTasks.push({
          taskId: `QC-${payload.receipt_id}-${line.line_id}`,
          lineId: line.line_id,
          productId: line.product_id,
          productSku: product.sku,
          quantity: line.quantity_received,
          lotNumber: line.lot_number,
          inspectionType: this.determineInspectionType(product),
          criteria,
        });
      }

      // Create quality inspection event
      const inspectionEvent = createEvent(
        'QualityInspectionCreated',
        {
          receipt_id: payload.receipt_id,
          warehouse_id: payload.warehouse_id,
          total_tasks: inspectionTasks.length,
          total_quantity: inspectionTasks.reduce((sum, t) => sum + t.quantity, 0),
          inspection_tasks: inspectionTasks,
          created_at: new Date().toISOString(),
          status: 'PENDING',
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
        `Created ${inspectionTasks.length} quality inspection tasks`,
        {
          taskCount: inspectionTasks.length,
          tasks: inspectionTasks,
        },
        [inspectionEvent]
      );
    } catch (error) {
      context.logger.error('Failed to create quality inspections', error);
      return this.createFailureResult(
        'Failed to create quality inspections',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private determineInspectionType(product: {
    isHazmat: boolean;
    temperatureRequired: string | null;
    isLotTracked: boolean;
  }): string {
    if (product.isHazmat) return 'HAZMAT_INSPECTION';
    if (product.temperatureRequired && product.temperatureRequired !== 'AMBIENT') {
      return 'TEMPERATURE_CONTROLLED';
    }
    if (product.isLotTracked) return 'LOT_VERIFICATION';
    return 'STANDARD';
  }

  private determineInspectionCriteria(
    product: {
      isHazmat: boolean;
      temperatureRequired: string | null;
      shelfLifeDays: number | null;
      isLotTracked: boolean;
    },
    line: { lot_number?: string; quantity_received: number }
  ): string[] {
    const criteria: string[] = [
      'VISUAL_INSPECTION',
      'QUANTITY_VERIFICATION',
      'PACKAGING_CONDITION',
    ];

    if (product.isLotTracked && line.lot_number) {
      criteria.push('LOT_NUMBER_VERIFICATION');
      criteria.push('EXPIRATION_DATE_CHECK');
    }

    if (product.shelfLifeDays && product.shelfLifeDays < 90) {
      criteria.push('SHELF_LIFE_VALIDATION');
    }

    if (product.temperatureRequired && product.temperatureRequired !== 'AMBIENT') {
      criteria.push('TEMPERATURE_LOG_REVIEW');
      criteria.push('COLD_CHAIN_VERIFICATION');
    }

    if (product.isHazmat) {
      criteria.push('HAZMAT_LABELING_CHECK');
      criteria.push('SDS_VERIFICATION');
      criteria.push('CONTAINER_INTEGRITY');
    }

    // Sample inspection for large quantities
    if (line.quantity_received > 100) {
      criteria.push('SAMPLE_TESTING');
    }

    return criteria;
  }
}
