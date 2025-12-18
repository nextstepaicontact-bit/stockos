import { compareLotsByFEFO, isLotAvailable, type LotBatch } from '../entities/lot-batch.js';
import type { StockLevel } from '../entities/stock-level.js';

export interface AllocationRequest {
  productId: string;
  variantId?: string;
  requestedQuantity: number;
  warehouseId: string;
  referenceType: string;
  referenceId: string;
  preferredLocations?: string[];
  excludedLots?: string[];
  minDaysToExpiration?: number;
}

export interface InventorySource {
  stockLevel: StockLevel;
  lotBatch?: LotBatch;
}

export interface AllocationLine {
  stockLevelId: string;
  locationId: string;
  lotBatchId?: string;
  lotNumber?: string;
  expirationDate?: Date;
  quantity: number;
  daysToExpiration?: number;
}

export interface AllocationResult {
  success: boolean;
  fullyAllocated: boolean;
  requestedQuantity: number;
  allocatedQuantity: number;
  shortfallQuantity: number;
  allocations: AllocationLine[];
  skippedSources: {
    reason: string;
    stockLevelId: string;
    lotBatchId?: string;
  }[];
}

export class FefoAllocator {
  private minDaysToExpiration: number;
  private referenceDate: Date;

  constructor(options: { minDaysToExpiration?: number; referenceDate?: Date } = {}) {
    this.minDaysToExpiration = options.minDaysToExpiration ?? 0;
    this.referenceDate = options.referenceDate ?? new Date();
  }

  allocate(
    request: AllocationRequest,
    sources: InventorySource[]
  ): AllocationResult {
    const allocations: AllocationLine[] = [];
    const skippedSources: AllocationResult['skippedSources'] = [];
    let remainingQty = request.requestedQuantity;

    // Filter and sort sources by FEFO
    const validSources = this.filterAndSortSources(sources, request);

    for (const source of validSources) {
      if (remainingQty <= 0) break;

      const { stockLevel, lotBatch } = source;

      // Skip if no available quantity
      if (stockLevel.quantityAvailable <= 0) {
        skippedSources.push({
          reason: 'No available quantity',
          stockLevelId: stockLevel.id,
          lotBatchId: lotBatch?.id,
        });
        continue;
      }

      // Check lot status
      if (lotBatch && !isLotAvailable(lotBatch, this.referenceDate)) {
        skippedSources.push({
          reason: `Lot not available: ${lotBatch.status}`,
          stockLevelId: stockLevel.id,
          lotBatchId: lotBatch.id,
        });
        continue;
      }

      // Check expiration
      if (lotBatch?.expirationDate) {
        const daysToExp = this.calculateDaysToExpiration(lotBatch.expirationDate);
        if (daysToExp < this.minDaysToExpiration) {
          skippedSources.push({
            reason: `Too close to expiration: ${daysToExp} days`,
            stockLevelId: stockLevel.id,
            lotBatchId: lotBatch.id,
          });
          continue;
        }
      }

      // Check excluded lots
      if (lotBatch && request.excludedLots?.includes(lotBatch.id)) {
        skippedSources.push({
          reason: 'Lot excluded by request',
          stockLevelId: stockLevel.id,
          lotBatchId: lotBatch.id,
        });
        continue;
      }

      // Allocate from this source
      const allocateQty = Math.min(remainingQty, stockLevel.quantityAvailable);

      allocations.push({
        stockLevelId: stockLevel.id,
        locationId: stockLevel.locationId,
        lotBatchId: lotBatch?.id,
        lotNumber: lotBatch?.lotNumber,
        expirationDate: lotBatch?.expirationDate,
        quantity: allocateQty,
        daysToExpiration: lotBatch?.expirationDate
          ? this.calculateDaysToExpiration(lotBatch.expirationDate)
          : undefined,
      });

      remainingQty -= allocateQty;
    }

    const allocatedQuantity = request.requestedQuantity - remainingQty;

    return {
      success: allocatedQuantity > 0,
      fullyAllocated: remainingQty === 0,
      requestedQuantity: request.requestedQuantity,
      allocatedQuantity,
      shortfallQuantity: remainingQty,
      allocations,
      skippedSources,
    };
  }

  private filterAndSortSources(
    sources: InventorySource[],
    request: AllocationRequest
  ): InventorySource[] {
    // Filter by product/variant/warehouse
    let filtered = sources.filter(s =>
      s.stockLevel.productId === request.productId &&
      s.stockLevel.warehouseId === request.warehouseId &&
      (!request.variantId || s.stockLevel.variantId === request.variantId)
    );

    // Prioritize preferred locations
    if (request.preferredLocations?.length) {
      filtered = filtered.sort((a, b) => {
        const aPreferred = request.preferredLocations!.includes(a.stockLevel.locationId);
        const bPreferred = request.preferredLocations!.includes(b.stockLevel.locationId);
        if (aPreferred && !bPreferred) return -1;
        if (!aPreferred && bPreferred) return 1;
        return 0;
      });
    }

    // Sort by FEFO within each priority group
    filtered.sort((a, b) => {
      // First by preferred location (already done above)
      const aPreferred = request.preferredLocations?.includes(a.stockLevel.locationId) ?? false;
      const bPreferred = request.preferredLocations?.includes(b.stockLevel.locationId) ?? false;
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;

      // Then by FEFO
      if (a.lotBatch && b.lotBatch) {
        return compareLotsByFEFO(a.lotBatch, b.lotBatch);
      }
      if (a.lotBatch) return -1; // Lot-tracked items first
      if (b.lotBatch) return 1;

      // Finally by location pick sequence
      return 0;
    });

    return filtered;
  }

  private calculateDaysToExpiration(expirationDate: Date): number {
    const diffMs = expirationDate.getTime() - this.referenceDate.getTime();
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }
}

export function allocateWithFefo(
  request: AllocationRequest,
  sources: InventorySource[],
  options?: { minDaysToExpiration?: number; referenceDate?: Date }
): AllocationResult {
  const allocator = new FefoAllocator(options);
  return allocator.allocate(request, sources);
}
