import type { EventEnvelope } from '@stockos/contracts';
import { createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';

export class DemandForecastAgent extends BaseAgent {
  readonly name = 'DemandForecastAgent';
  readonly description = 'Generates demand forecasts using historical data and trends';
  readonly subscribesTo = [
    'ScheduledDemandForecast', // Triggered by cron (weekly)
    'DemandForecastRequested',
  ];

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      product_ids?: string[];
      warehouse_id?: string;
      forecast_days?: number;
      history_days?: number;
    };

    const forecastDays = payload.forecast_days ?? 30;
    const historyDays = payload.history_days ?? 180;

    context.logger.info('Generating demand forecasts', {
      productCount: payload.product_ids?.length ?? 'all',
      forecastDays,
      historyDays,
    });

    try {
      // Get products to forecast
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
          abcClass: true,
        },
      });

      const forecasts: Array<{
        productId: string;
        productSku: string;
        dailyForecasts: Array<{
          date: string;
          forecastedDemand: number;
          confidenceLow: number;
          confidenceHigh: number;
        }>;
        totalForecastedDemand: number;
        trend: 'INCREASING' | 'STABLE' | 'DECREASING';
        seasonalityDetected: boolean;
      }> = [];

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - historyDays);

      for (const product of products) {
        const history = await this.getHistoricalDemand(
          context.tenantId,
          product.id,
          startDate,
          payload.warehouse_id
        );

        if (history.length < 30) {
          // Not enough data
          continue;
        }

        const forecast = this.generateForecast(history, forecastDays);

        forecasts.push({
          productId: product.id,
          productSku: product.sku,
          dailyForecasts: forecast.dailyForecasts,
          totalForecastedDemand: forecast.totalDemand,
          trend: forecast.trend,
          seasonalityDetected: forecast.seasonalityDetected,
        });
      }

      // Create forecast event
      const forecastEvent = createEvent(
        'DemandForecastGenerated',
        {
          warehouse_id: payload.warehouse_id,
          forecast_period_days: forecastDays,
          history_period_days: historyDays,
          products_forecasted: forecasts.length,
          generated_at: new Date().toISOString(),
          forecasts: forecasts.map(f => ({
            product_id: f.productId,
            product_sku: f.productSku,
            total_forecasted_demand: f.totalForecastedDemand,
            trend: f.trend,
            seasonality_detected: f.seasonalityDetected,
            daily_forecasts: f.dailyForecasts.slice(0, 7), // First week only for event
          })),
          summary: {
            increasing_trend: forecasts.filter(f => f.trend === 'INCREASING').length,
            stable_trend: forecasts.filter(f => f.trend === 'STABLE').length,
            decreasing_trend: forecasts.filter(f => f.trend === 'DECREASING').length,
            with_seasonality: forecasts.filter(f => f.seasonalityDetected).length,
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
        `Generated forecasts for ${forecasts.length} products`,
        {
          productsForecasted: forecasts.length,
          forecastPeriod: forecastDays,
        },
        [forecastEvent]
      );
    } catch (error) {
      context.logger.error('Failed to generate demand forecasts', error);
      return this.createFailureResult(
        'Failed to generate demand forecasts',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async getHistoricalDemand(
    tenantId: string,
    productId: string,
    startDate: Date,
    warehouseId?: string
  ): Promise<Array<{ date: Date; quantity: number }>> {
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

    for (const mov of movements) {
      const dateKey = mov.createdAt.toISOString().split('T')[0];
      dailyDemand.set(dateKey, (dailyDemand.get(dateKey) ?? 0) + mov.quantity);
    }

    return Array.from(dailyDemand.entries()).map(([dateStr, quantity]) => ({
      date: new Date(dateStr),
      quantity,
    }));
  }

  private generateForecast(
    history: Array<{ date: Date; quantity: number }>,
    forecastDays: number
  ): {
    dailyForecasts: Array<{
      date: string;
      forecastedDemand: number;
      confidenceLow: number;
      confidenceHigh: number;
    }>;
    totalDemand: number;
    trend: 'INCREASING' | 'STABLE' | 'DECREASING';
    seasonalityDetected: boolean;
  } {
    // Simple moving average with trend detection
    // In production, would use more sophisticated methods (Holt-Winters, ARIMA, etc.)

    const quantities = history.map(h => h.quantity);

    // Calculate moving averages
    const shortTermMA = this.movingAverage(quantities, 7);
    const longTermMA = this.movingAverage(quantities, 30);

    // Detect trend
    const recentShortMA = shortTermMA.slice(-7);
    const recentLongMA = longTermMA.slice(-7);
    const shortAvg = recentShortMA.reduce((a, b) => a + b, 0) / recentShortMA.length;
    const longAvg = recentLongMA.reduce((a, b) => a + b, 0) / recentLongMA.length;

    let trend: 'INCREASING' | 'STABLE' | 'DECREASING';
    if (shortAvg > longAvg * 1.1) {
      trend = 'INCREASING';
    } else if (shortAvg < longAvg * 0.9) {
      trend = 'DECREASING';
    } else {
      trend = 'STABLE';
    }

    // Simple seasonality detection (compare same day of week patterns)
    const seasonalityDetected = this.detectWeeklySeasonality(history);

    // Generate forecasts using weighted average of recent demand
    const recentDemand = quantities.slice(-14);
    const avgDemand = recentDemand.reduce((a, b) => a + b, 0) / recentDemand.length;
    const stdDev = Math.sqrt(
      recentDemand.reduce((sum, q) => sum + Math.pow(q - avgDemand, 2), 0) / recentDemand.length
    );

    // Apply trend adjustment
    const trendMultiplier = trend === 'INCREASING' ? 1.05 : trend === 'DECREASING' ? 0.95 : 1.0;

    const dailyForecasts: Array<{
      date: string;
      forecastedDemand: number;
      confidenceLow: number;
      confidenceHigh: number;
    }> = [];

    const startDate = new Date();
    for (let i = 1; i <= forecastDays; i++) {
      const forecastDate = new Date(startDate);
      forecastDate.setDate(forecastDate.getDate() + i);

      // Apply day-of-week factor if seasonality detected
      let dayFactor = 1.0;
      if (seasonalityDetected) {
        const dayOfWeek = forecastDate.getDay();
        dayFactor = this.getDayOfWeekFactor(history, dayOfWeek);
      }

      const baseForecast = avgDemand * Math.pow(trendMultiplier, i / 7) * dayFactor;
      const confidenceInterval = stdDev * 1.96; // 95% confidence

      dailyForecasts.push({
        date: forecastDate.toISOString().split('T')[0],
        forecastedDemand: Math.round(baseForecast),
        confidenceLow: Math.max(0, Math.round(baseForecast - confidenceInterval)),
        confidenceHigh: Math.round(baseForecast + confidenceInterval),
      });
    }

    const totalDemand = dailyForecasts.reduce((sum, f) => sum + f.forecastedDemand, 0);

    return {
      dailyForecasts,
      totalDemand,
      trend,
      seasonalityDetected,
    };
  }

  private movingAverage(data: number[], window: number): number[] {
    const result: number[] = [];
    for (let i = window - 1; i < data.length; i++) {
      const slice = data.slice(i - window + 1, i + 1);
      result.push(slice.reduce((a, b) => a + b, 0) / window);
    }
    return result;
  }

  private detectWeeklySeasonality(
    history: Array<{ date: Date; quantity: number }>
  ): boolean {
    if (history.length < 28) return false;

    // Group by day of week
    const byDayOfWeek: number[][] = [[], [], [], [], [], [], []];
    for (const h of history) {
      byDayOfWeek[h.date.getDay()].push(h.quantity);
    }

    // Calculate variance between days vs within days
    const dayAverages = byDayOfWeek.map(
      (day) => day.reduce((a, b) => a + b, 0) / (day.length || 1)
    );

    const overallAvg = dayAverages.reduce((a, b) => a + b, 0) / 7;
    const betweenDayVariance =
      dayAverages.reduce((sum, avg) => sum + Math.pow(avg - overallAvg, 2), 0) / 7;

    // If variance between days is significant, seasonality is present
    return betweenDayVariance > overallAvg * 0.1;
  }

  private getDayOfWeekFactor(
    history: Array<{ date: Date; quantity: number }>,
    dayOfWeek: number
  ): number {
    const allQuantities = history.map(h => h.quantity);
    const overallAvg = allQuantities.reduce((a, b) => a + b, 0) / allQuantities.length;

    const dayQuantities = history
      .filter(h => h.date.getDay() === dayOfWeek)
      .map(h => h.quantity);

    if (dayQuantities.length === 0) return 1.0;

    const dayAvg = dayQuantities.reduce((a, b) => a + b, 0) / dayQuantities.length;
    return overallAvg > 0 ? dayAvg / overallAvg : 1.0;
  }
}
