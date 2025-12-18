export interface DemandHistory {
  date: Date;
  quantity: number;
}

export interface SafetyStockParams {
  avgDailyDemand: number;
  demandStdDev: number;
  leadTimeDays: number;
  leadTimeStdDev?: number;
  serviceLevel: number; // 0.90 to 0.99
  seasonalityFactor?: number; // 1.0 = no seasonality
}

export interface SafetyStockResult {
  safetyStock: number;
  reorderPoint: number;
  avgDailyDemand: number;
  demandVariability: number;
  serviceLevelAchieved: number;
  formula: string;
}

// Z-scores for common service levels
const SERVICE_LEVEL_Z_SCORES: Record<number, number> = {
  0.90: 1.28,
  0.91: 1.34,
  0.92: 1.41,
  0.93: 1.48,
  0.94: 1.55,
  0.95: 1.65,
  0.96: 1.75,
  0.97: 1.88,
  0.98: 2.05,
  0.99: 2.33,
  0.995: 2.58,
  0.999: 3.09,
};

export class SafetyStockCalculator {
  /**
   * Calculate safety stock using the standard formula:
   * SS = Z × √(LT × σD² + D² × σLT²)
   *
   * Where:
   * - Z = service level z-score
   * - LT = average lead time
   * - σD = demand standard deviation
   * - D = average demand
   * - σLT = lead time standard deviation
   */
  calculate(params: SafetyStockParams): SafetyStockResult {
    const {
      avgDailyDemand,
      demandStdDev,
      leadTimeDays,
      leadTimeStdDev = 0,
      serviceLevel,
      seasonalityFactor = 1.0,
    } = params;

    // Get Z-score for service level
    const zScore = this.getZScore(serviceLevel);

    // Apply seasonality to demand
    const adjustedDemand = avgDailyDemand * seasonalityFactor;
    const adjustedStdDev = demandStdDev * seasonalityFactor;

    // Calculate safety stock using the combined variance formula
    const demandVariance = leadTimeDays * Math.pow(adjustedStdDev, 2);
    const leadTimeVariance = Math.pow(adjustedDemand, 2) * Math.pow(leadTimeStdDev, 2);
    const combinedStdDev = Math.sqrt(demandVariance + leadTimeVariance);

    const safetyStock = Math.ceil(zScore * combinedStdDev);

    // Calculate reorder point
    const avgLeadTimeDemand = adjustedDemand * leadTimeDays;
    const reorderPoint = Math.ceil(avgLeadTimeDemand + safetyStock);

    return {
      safetyStock,
      reorderPoint,
      avgDailyDemand: adjustedDemand,
      demandVariability: adjustedStdDev / adjustedDemand, // Coefficient of variation
      serviceLevelAchieved: serviceLevel,
      formula: `SS = ${zScore.toFixed(2)} × √(${leadTimeDays} × ${adjustedStdDev.toFixed(2)}² + ${adjustedDemand.toFixed(2)}² × ${leadTimeStdDev.toFixed(2)}²) = ${safetyStock}`,
    };
  }

  /**
   * Calculate demand statistics from historical data
   */
  analyzeDemanHistory(history: DemandHistory[]): {
    avgDailyDemand: number;
    demandStdDev: number;
    coefficientOfVariation: number;
    daysWithZeroDemand: number;
  } {
    if (history.length === 0) {
      return {
        avgDailyDemand: 0,
        demandStdDev: 0,
        coefficientOfVariation: 0,
        daysWithZeroDemand: 0,
      };
    }

    const quantities = history.map(h => h.quantity);
    const sum = quantities.reduce((a, b) => a + b, 0);
    const avgDailyDemand = sum / quantities.length;

    const squaredDiffs = quantities.map(q => Math.pow(q - avgDailyDemand, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / quantities.length;
    const demandStdDev = Math.sqrt(variance);

    const daysWithZeroDemand = quantities.filter(q => q === 0).length;
    const coefficientOfVariation = avgDailyDemand > 0 ? demandStdDev / avgDailyDemand : 0;

    return {
      avgDailyDemand,
      demandStdDev,
      coefficientOfVariation,
      daysWithZeroDemand,
    };
  }

  /**
   * Calculate seasonality factors from monthly data
   */
  calculateSeasonalityFactors(monthlyDemand: number[]): number[] {
    if (monthlyDemand.length !== 12) {
      throw new Error('Monthly demand must have exactly 12 values');
    }

    const total = monthlyDemand.reduce((a, b) => a + b, 0);
    const monthlyAvg = total / 12;

    if (monthlyAvg === 0) {
      return new Array(12).fill(1.0);
    }

    return monthlyDemand.map(demand => demand / monthlyAvg);
  }

  private getZScore(serviceLevel: number): number {
    // Find closest service level
    const levels = Object.keys(SERVICE_LEVEL_Z_SCORES).map(Number).sort((a, b) => a - b);

    for (let i = 0; i < levels.length; i++) {
      if (serviceLevel <= levels[i]) {
        return SERVICE_LEVEL_Z_SCORES[levels[i]];
      }
    }

    // Default to highest
    return SERVICE_LEVEL_Z_SCORES[0.999];
  }
}

export function calculateSafetyStock(params: SafetyStockParams): SafetyStockResult {
  const calculator = new SafetyStockCalculator();
  return calculator.calculate(params);
}
