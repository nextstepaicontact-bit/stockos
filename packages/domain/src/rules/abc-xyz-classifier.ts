import { calculateABCClass, calculateXYZClass, type ABCClass, type XYZClass } from '../entities/product.js';

export interface ProductSalesData {
  productId: string;
  totalRevenue: number;
  totalQuantity: number;
  dailyQuantities: number[];
}

export interface ClassificationResult {
  productId: string;
  abcClass: ABCClass;
  xyzClass: XYZClass;
  combinedClass: string;
  revenuePercent: number;
  cumulativeRevenuePercent: number;
  coefficientOfVariation: number;
  avgDailyDemand: number;
  demandStdDev: number;
}

export interface ClassificationSummary {
  totalProducts: number;
  classifications: ClassificationResult[];
  distribution: {
    AX: number; AY: number; AZ: number;
    BX: number; BY: number; BZ: number;
    CX: number; CY: number; CZ: number;
  };
  recommendations: string[];
}

export class AbcXyzClassifier {
  /**
   * Classify products using ABC-XYZ analysis
   * ABC: Based on revenue contribution (Pareto)
   * XYZ: Based on demand variability (coefficient of variation)
   */
  classify(salesData: ProductSalesData[]): ClassificationSummary {
    if (salesData.length === 0) {
      return {
        totalProducts: 0,
        classifications: [],
        distribution: {
          AX: 0, AY: 0, AZ: 0,
          BX: 0, BY: 0, BZ: 0,
          CX: 0, CY: 0, CZ: 0,
        },
        recommendations: [],
      };
    }

    // Calculate total revenue
    const totalRevenue = salesData.reduce((sum, p) => sum + p.totalRevenue, 0);

    // Sort by revenue descending for ABC
    const sortedByRevenue = [...salesData].sort((a, b) => b.totalRevenue - a.totalRevenue);

    // Calculate classifications
    let cumulativeRevenue = 0;
    const classifications: ClassificationResult[] = sortedByRevenue.map(product => {
      const revenuePercent = totalRevenue > 0 ? (product.totalRevenue / totalRevenue) * 100 : 0;
      cumulativeRevenue += revenuePercent;

      const { avg, stdDev, cv } = this.calculateDemandStats(product.dailyQuantities);

      const abcClass = calculateABCClass(cumulativeRevenue);
      const xyzClass = calculateXYZClass(cv);

      return {
        productId: product.productId,
        abcClass,
        xyzClass,
        combinedClass: `${abcClass}${xyzClass}`,
        revenuePercent,
        cumulativeRevenuePercent: cumulativeRevenue,
        coefficientOfVariation: cv,
        avgDailyDemand: avg,
        demandStdDev: stdDev,
      };
    });

    // Calculate distribution
    const distribution = {
      AX: 0, AY: 0, AZ: 0,
      BX: 0, BY: 0, BZ: 0,
      CX: 0, CY: 0, CZ: 0,
    };

    for (const c of classifications) {
      const key = c.combinedClass as keyof typeof distribution;
      distribution[key]++;
    }

    // Generate recommendations
    const recommendations = this.generateRecommendations(classifications, distribution);

    return {
      totalProducts: salesData.length,
      classifications,
      distribution,
      recommendations,
    };
  }

  private calculateDemandStats(dailyQuantities: number[]): {
    avg: number;
    stdDev: number;
    cv: number;
  } {
    if (dailyQuantities.length === 0) {
      return { avg: 0, stdDev: 0, cv: 0 };
    }

    const sum = dailyQuantities.reduce((a, b) => a + b, 0);
    const avg = sum / dailyQuantities.length;

    if (avg === 0) {
      return { avg: 0, stdDev: 0, cv: 0 };
    }

    const squaredDiffs = dailyQuantities.map(q => Math.pow(q - avg, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / dailyQuantities.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / avg;

    return { avg, stdDev, cv };
  }

  private generateRecommendations(
    classifications: ClassificationResult[],
    distribution: ClassificationSummary['distribution']
  ): string[] {
    const recommendations: string[] = [];

    // AX items - high value, stable demand
    if (distribution.AX > 0) {
      recommendations.push(
        `AX items (${distribution.AX}): Maintain tight inventory control with frequent replenishment. ` +
        `Use safety stock formula with 99% service level.`
      );
    }

    // AZ items - high value, erratic demand
    if (distribution.AZ > 0) {
      recommendations.push(
        `AZ items (${distribution.AZ}): High revenue but unpredictable. Consider make-to-order ` +
        `or close coordination with sales for demand signals.`
      );
    }

    // CX items - low value, stable demand
    if (distribution.CX > 0) {
      recommendations.push(
        `CX items (${distribution.CX}): Low value but predictable. Use simple reorder point ` +
        `with bulk ordering to minimize ordering costs.`
      );
    }

    // CZ items - low value, erratic demand
    if (distribution.CZ > 0) {
      recommendations.push(
        `CZ items (${distribution.CZ}): Consider discontinuing or stocking only to order. ` +
        `These items tie up capital with little return.`
      );
    }

    // General recommendations based on distribution
    const totalA = distribution.AX + distribution.AY + distribution.AZ;
    const totalC = distribution.CX + distribution.CY + distribution.CZ;

    if (totalA > 0 && totalC > 0) {
      const aPercent = (totalA / classifications.length) * 100;
      recommendations.push(
        `Portfolio health: ${aPercent.toFixed(1)}% A-class items generating 80% revenue. ` +
        `Review ${totalC} C-class items for potential SKU rationalization.`
      );
    }

    return recommendations;
  }
}

export function classifyProducts(salesData: ProductSalesData[]): ClassificationSummary {
  const classifier = new AbcXyzClassifier();
  return classifier.classify(salesData);
}
