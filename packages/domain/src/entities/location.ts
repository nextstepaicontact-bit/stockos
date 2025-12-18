export type LocationType = 'BULK' | 'PICK' | 'STAGING' | 'RECEIVING' | 'SHIPPING' | 'QUARANTINE' | 'RETURN' | 'CROSS_DOCK';
export type TemperatureZone = 'AMBIENT' | 'CHILLED' | 'FROZEN' | 'CONTROLLED';

export interface Location {
  id: string;
  tenantId: string;
  warehouseId: string;
  code: string;
  zone: string;
  aisle?: string;
  rack?: string;
  shelf?: string;
  bin?: string;
  type: LocationType;
  temperatureZone: TemperatureZone;
  maxWeight?: number;
  maxVolume?: number;
  maxItems?: number;
  pickSequence?: number;
  isActive: boolean;
  allowMixedProducts: boolean;
  allowMixedLots: boolean;
  isHazmatCertified: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocationCapacity {
  location: Location;
  currentWeight?: number;
  currentVolume?: number;
  currentItems?: number;
  utilizationPercent: number;
}

export function canStoreProduct(
  location: Location,
  product: {
    temperatureRequired?: TemperatureZone;
    isHazmat?: boolean;
  }
): boolean {
  // Check temperature compatibility
  if (product.temperatureRequired && product.temperatureRequired !== location.temperatureZone) {
    // Allow ambient products in any zone
    if (product.temperatureRequired !== 'AMBIENT') {
      return false;
    }
  }

  // Check hazmat certification
  if (product.isHazmat && !location.isHazmatCertified) {
    return false;
  }

  return location.isActive;
}

export function calculateLocationUtilization(
  location: Location,
  currentWeight?: number,
  currentVolume?: number,
  currentItems?: number
): number {
  const utilizations: number[] = [];

  if (location.maxWeight && currentWeight !== undefined) {
    utilizations.push(currentWeight / location.maxWeight);
  }
  if (location.maxVolume && currentVolume !== undefined) {
    utilizations.push(currentVolume / location.maxVolume);
  }
  if (location.maxItems && currentItems !== undefined) {
    utilizations.push(currentItems / location.maxItems);
  }

  if (utilizations.length === 0) return 0;
  return Math.max(...utilizations) * 100;
}

export function parseLocationCode(code: string): {
  zone?: string;
  aisle?: string;
  rack?: string;
  shelf?: string;
  bin?: string;
} {
  // Standard format: ZONE-AISLE-RACK-SHELF-BIN (e.g., A-01-03-02-01)
  const parts = code.split('-');
  return {
    zone: parts[0],
    aisle: parts[1],
    rack: parts[2],
    shelf: parts[3],
    bin: parts[4],
  };
}
