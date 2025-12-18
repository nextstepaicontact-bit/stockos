import type { EventEnvelope } from '@stockos/contracts';
import { createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';
import { SafetyStockCalculator, type DemandHistory } from '@stockos/domain/rules';

export class SafetyStockAgent extends BaseAgent {
  readonly name = 'SafetyStockAgent';
  readonly description = 'Calculates and updates safety stock levels based on demand patterns';
  readonly subscribesTo = [
    'ScheduledSafetyStockRecalc', // Triggered by cron (weekly)
    'SafetyStockRecalcRequested',
  ];

  private calculator = new SafetyStockCalculator();

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      product_ids?: string[];
      warehouse_id?: string;
      service_level?: number;
      analysis_days?: number;
    };

    const serviceLevel = payload.service_level ?? 0.95;
    const analysisDays = payload.analysis_days ?? 90;

    context.logger.info('Calculating safety stock levels', {
      productCount: payload.product_ids?.length ?? 'all',
      serviceLevel,
      analysisDays,
    });

    try {
      // Get products to analyze
      const products = await prisma.product.findMany({
        where: {
          tenantId: context.tenantId,
          isActive: true,
          ...(payload.product_ids && { id: { in: payload.product_ids } }),
        },
        select: {
          id: true,
          sku: true,
          name: true,
          leadTimeDays: true,
          safetyStock: true,
          reorderPoint: true,
        },
      });

      const results: Array<{
        productId: string;
        productSku: string;
        oldSafetyStock: number | null;
        newSafetyStock: number;
        oldReorderPoint: number | null;
        newReorderPoint: number;
        avgDailyDemand: number;
        demandStdDev: number;
      }> = [];

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - analysisDays);

      for (const product of products) {
        // Get demand history
        const demandHistory = await this.getDemandHistory(
          context.tenantId,
          product.id,
          startDate,
          payload.warehouse_id
        );

        if (demandHistory.length < 7) {
          // Not enough data for meaningful calculation
          continue;
        }

        // Analyze demand
        const demandStats = this.calculator.analyzeDemanHistory(demandHistory);

        // Calculate safety stock
        const result = this.calculator.calculate({
          avgDailyDemand: demandStats.avgDailyDemand,
          demandStdDev: demandStats.demandStdDev,
          leadTimeDays: product.leadTimeDays ?? 7,
          serviceLevel,
        });

        results.push({
          productId: product.id,
          productSku: product.sku,
          oldSafetyStock: product.safetyStock,
          newSafetyStock: result.safetyStock,
          oldReorderPoint: product.reorderPoint,
          newReorderPoint: result.reorderPoint,
          avgDailyDemand: demandStats.avgDailyDemand,
          demandStdDev: demandStats.demandStdDev,
        });

        // Update product
        await prisma.product.update({
          where: { id: product.id },
          data: {
            safetyStock: result.safetyStock,
            reorderPoint: result.reorderPoint,
            metadata: {
              lastSafetyStockCalc: new Date().toISOString(),
              serviceLevel,
              avgDailyDemand: demandStats.avgDailyDemand,
              demandStdDev: demandStats.demandStdDev,
              formula: result.formula,
            },
          },
        });
      }

      // Identify significant changes
      const significantChanges = results.filter(r => {
        if (!r.oldSafetyStock) return true;
        const changePercent = Math.abs(r.newSafetyStock - r.oldSafetyStock) / r.oldSafetyStock;
        return changePercent > 0.2; // > 20% change
      });

      // Create analysis event
      const analysisEvent = createEvent(
        'SafetyStockRecalculated',
        {
          warehouse_id: payload.warehouse_id,
          service_level: serviceLevel,
          analysis_days: analysisDays,
          products_analyzed: results.length,
          significant_changes: significantChanges.length,
          changes: significantChanges.map(c => ({
            product_id: c.productId,
            product_sku: c.productSku,
            old_safety_stock: c.oldSafetyStock,
            new_safety_stock: c.newSafetyStock,
            old_reorder_point: c.oldReorderPoint,
            new_reorder_point: c.newReorderPoint,
          })),
          summary: {
            avg_safety_stock_change:
              results.length > 0
                ? results.reduce((sum, r) => sum + (r.newSafetyStock - (r.oldSafetyStock ?? 0)), 0) /
                  results.length
                : 0,
            products_increased: results.filter(
              r => r.newSafetyStock > (r.oldSafetyStock ?? 0)
            ).length,
            products_decreased: results.filter(
              r => r.newSafetyStock < (r.oldSafetyStock ?? Infinity)
            ).length,
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
        `Recalculated safety stock for ${results.length} products`,
        {
          productsAnalyzed: results.length,
          significantChanges: significantChanges.length,
        },
        [analysisEvent]
      );
    } catch (error) {
      context.logger.error('Failed to calculate safety stock', error);
      return this.createFailureResult(
        'Failed to calculate safety stock',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async getDemandHistory(
    tenantId: string,
    productId: string,
    startDate: Date,
    warehouseId?: string
  ): Promise<DemandHistory[]> {
    const movements = await prisma.movement.findMany({
      where: {
        tenantId,
        productId,
        movementType: 'SHIP',
        createdAt: { gte: startDate },
        ...(warehouseId && { warehouseId }),
      },
      select: {
        quantity: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Aggregate by day
    const dailyDemand = new Map<string, number>();
    const currentDate = new Date(startDate);
    const endDate = new Date();

    // Initialize all days to 0
    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      dailyDemand.set(dateKey, 0);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Add actual demand
    for (const mov of movements) {
      const dateKey = mov.createdAt.toISOString().split('T')[0];
      dailyDemand.set(dateKey, (dailyDemand.get(dateKey) ?? 0) + mov.quantity);
    }

    return Array.from(dailyDemand.entries()).map(([dateStr, quantity]) => ({
      date: new Date(dateStr),
      quantity,
    }));
  }
}
