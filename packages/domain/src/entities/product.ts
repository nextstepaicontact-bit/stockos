export type ABCClass = 'A' | 'B' | 'C';
export type XYZClass = 'X' | 'Y' | 'Z';

export interface Product {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  description?: string;
  barcode?: string;
  categoryId?: string;
  unitOfMeasure: string;
  weight?: number;
  volume?: number;
  abcClass?: ABCClass;
  xyzClass?: XYZClass;
  reorderPoint?: number;
  safetyStock?: number;
  maxStock?: number;
  leadTimeDays?: number;
  shelfLifeDays?: number;
  temperatureRequired?: string;
  isHazmat: boolean;
  isSerialTracked: boolean;
  isLotTracked: boolean;
  isActive: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductVelocity {
  productId: string;
  avgDailyDemand: number;
  demandStdDev: number;
  daysOfHistory: number;
  lastCalculatedAt: Date;
}

export function calculateABCClass(
  cumulativeRevenuePercent: number
): ABCClass {
  // A: Top 80% of revenue (typically 20% of items)
  // B: Next 15% of revenue (typically 30% of items)
  // C: Bottom 5% of revenue (typically 50% of items)
  if (cumulativeRevenuePercent <= 80) return 'A';
  if (cumulativeRevenuePercent <= 95) return 'B';
  return 'C';
}

export function calculateXYZClass(
  coefficientOfVariation: number
): XYZClass {
  // X: CV < 0.5 (stable demand)
  // Y: 0.5 <= CV < 1.0 (moderate variability)
  // Z: CV >= 1.0 (high variability)
  if (coefficientOfVariation < 0.5) return 'X';
  if (coefficientOfVariation < 1.0) return 'Y';
  return 'Z';
}

export function getProductPriority(
  abcClass?: ABCClass,
  xyzClass?: XYZClass
): number {
  // Priority matrix for inventory management
  // AX = highest priority (1), CZ = lowest priority (9)
  const abcScore = abcClass === 'A' ? 0 : abcClass === 'B' ? 3 : 6;
  const xyzScore = xyzClass === 'X' ? 1 : xyzClass === 'Y' ? 2 : 3;
  return abcScore + xyzScore;
}

export function requiresExpirationTracking(product: Product): boolean {
  return product.isLotTracked && product.shelfLifeDays !== undefined && product.shelfLifeDays > 0;
}
