import type { EventEnvelope } from '@stockos/contracts';
import { createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';
import { classifyProducts, type ProductSalesData } from '@stockos/domain/rules';

export class AbcXyzAgent extends BaseAgent {
  readonly name = 'AbcXyzAgent';
  readonly description = 'Performs ABC-XYZ classification of products based on sales data';
  readonly subscribesTo = [
    'ScheduledAbcXyzAnalysis', // Triggered by cron (monthly)
    'AbcXyzAnalysisRequested',
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      warehouse_id?: string;
      analysis_period_days?: number;
    };

    const analysisPeriodDays = payload.analysis_period_days ?? 90;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - analysisPeriodDays);

    context.logger.info('Running ABC-XYZ analysis', {
      warehouseId: payload.warehouse_id,
      periodDays: analysisPeriodDays,
    });

    try {
      // Get sales data for the period
      const salesData = await this.getSalesData(
        context.tenantId,
        startDate,
        payload.warehouse_id
      );

      if (salesData.length === 0) {
        return this.createSuccessResult('No sales data available for analysis');
      }

      // Run classification
      const classification = classifyProducts(salesData);

      // Update product classifications in database
      await this.updateProductClassifications(classification.classifications);

      // Create analysis event
      const analysisEvent = createEvent(
        'AbcXyzAnalysisCompleted',
        {
          warehouse_id: payload.warehouse_id,
          analysis_period_days: analysisPeriodDays,
          analysis_date: new Date().toISOString(),
          total_products: classification.totalProducts,
          distribution: classification.distribution,
          recommendations: classification.recommendations,
          top_changes: this.identifySignificantChanges(classification.classifications),
          summary: {
            a_class_count:
              classification.distribution.AX +
              classification.distribution.AY +
              classification.distribution.AZ,
            b_class_count:
              classification.distribution.BX +
              classification.distribution.BY +
              classification.distribution.BZ,
            c_class_count:
              classification.distribution.CX +
              classification.distribution.CY +
              classification.distribution.CZ,
          },
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
        `Classified ${classification.totalProducts} products`,
        {
          totalProducts: classification.totalProducts,
          distribution: classification.distribution,
          recommendations: classification.recommendations,
        },
        [analysisEvent]
      );
    } catch (error) {
      context.logger.error('Failed to run ABC-XYZ analysis', error);
      return this.createFailureResult(
        'Failed to run ABC-XYZ analysis',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async getSalesData(
    tenantId: string,
    startDate: Date,
    warehouseId?: string
  ): Promise<ProductSalesData[]> {
    // Get movements of type SHIP for the period
    const movements = await prisma.movement.findMany({
      where: {
        tenantId,
        movementType: 'SHIP',
        createdAt: { gte: startDate },
        ...(warehouseId && { warehouseId }),
      },
      select: {
        productId: true,
        quantity: true,
        unitCost: true,
        createdAt: true,
      },
    });

    // Aggregate by product
    const productMap = new Map<
      string,
      {
        totalRevenue: number;
        totalQuantity: number;
        dailyQuantities: Map<string, number>;
      }
    >();

    for (const mov of movements) {
      const existing = productMap.get(mov.productId) ?? {
        totalRevenue: 0,
        totalQuantity: 0,
        dailyQuantities: new Map(),
      };

      existing.totalQuantity += mov.quantity;
      existing.totalRevenue += mov.quantity * (mov.unitCost ? Number(mov.unitCost) : 10); // Default price

      const dateKey = mov.createdAt.toISOString().split('T')[0];
      existing.dailyQuantities.set(
        dateKey,
        (existing.dailyQuantities.get(dateKey) ?? 0) + mov.quantity
      );

      productMap.set(mov.productId, existing);
    }

    // Convert to ProductSalesData format
    return Array.from(productMap.entries()).map(([productId, data]) => ({
      productId,
      totalRevenue: data.totalRevenue,
      totalQuantity: data.totalQuantity,
      dailyQuantities: Array.from(data.dailyQuantities.values()),
    }));
  }

  private async updateProductClassifications(
    classifications: Array<{
      productId: string;
      abcClass: string;
      xyzClass: string;
      avgDailyDemand: number;
      demandStdDev: number;
    }>
  ): Promise<void> {
    // Batch update products
    for (const c of classifications) {
      await prisma.product.update({
        where: { id: c.productId },
        data: {
          abcClass: c.abcClass,
          xyzClass: c.xyzClass,
          metadata: {
            lastAbcXyzAnalysis: new Date().toISOString(),
            avgDailyDemand: c.avgDailyDemand,
            demandStdDev: c.demandStdDev,
          },
        },
      });
    }
  }

  private identifySignificantChanges(
    classifications: Array<{
      productId: string;
      abcClass: string;
      xyzClass: string;
    }>
  ): Array<{ productId: string; change: string }> {
    // In a real implementation, this would compare with previous classifications
    // For now, just return empty array
    return [];
  }
}
