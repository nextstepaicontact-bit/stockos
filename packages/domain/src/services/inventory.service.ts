import type { StockLevel, StockLevelWithDetails } from '../entities/stock-level.js';

export interface StockQuery {
  tenantId: string;
  warehouseId?: string;
  productId?: string;
  variantId?: string;
  locationId?: string;
  lotBatchId?: string;
  includeZeroStock?: boolean;
}

export interface StockSummary {
  productId: string;
  variantId?: string;
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  totalInbound: number;
  totalOutbound: number;
  locationCount: number;
  lotCount: number;
}

export interface InventorySnapshot {
  warehouseId: string;
  asOf: Date;
  totalSKUs: number;
  totalUnits: number;
  totalValue: number;
  stockByZone: Record<string, number>;
  expiringWithin30Days: number;
  belowReorderPoint: number;
}

export interface IInventoryRepository {
  findStockLevels(query: StockQuery): Promise<StockLevelWithDetails[]>;
  getStockLevel(id: string): Promise<StockLevel | null>;
  getStockLevelForUpdate(
    tenantId: string,
    productId: string,
    locationId: string,
    lotBatchId?: string
  ): Promise<StockLevel | null>;
  upsertStockLevel(stock: Partial<StockLevel> & {
    tenantId: string;
    warehouseId: string;
    productId: string;
    locationId: string;
  }): Promise<StockLevel>;
  updateQuantities(
    id: string,
    delta: {
      onHand?: number;
      reserved?: number;
      inbound?: number;
      outbound?: number;
    },
    expectedVersion: number
  ): Promise<StockLevel>;
}

export class InventoryService {
  constructor(private repository: IInventoryRepository) {}

  async getStock(query: StockQuery): Promise<StockLevelWithDetails[]> {
    return this.repository.findStockLevels(query);
  }

  async getStockSummary(
    tenantId: string,
    productId: string,
    warehouseId?: string
  ): Promise<StockSummary> {
    const stocks = await this.repository.findStockLevels({
      tenantId,
      productId,
      warehouseId,
      includeZeroStock: false,
    });

    const lotIds = new Set<string>();
    const locationIds = new Set<string>();

    const summary = stocks.reduce(
      (acc, stock) => {
        acc.totalOnHand += stock.quantityOnHand;
        acc.totalReserved += stock.quantityReserved;
        acc.totalAvailable += stock.quantityAvailable;
        acc.totalInbound += stock.quantityInbound;
        acc.totalOutbound += stock.quantityOutbound;

        locationIds.add(stock.locationId);
        if (stock.lotBatchId) lotIds.add(stock.lotBatchId);

        return acc;
      },
      {
        productId,
        variantId: undefined as string | undefined,
        totalOnHand: 0,
        totalReserved: 0,
        totalAvailable: 0,
        totalInbound: 0,
        totalOutbound: 0,
        locationCount: 0,
        lotCount: 0,
      }
    );

    summary.locationCount = locationIds.size;
    summary.lotCount = lotIds.size;

    return summary;
  }

  async checkAvailability(
    tenantId: string,
    warehouseId: string,
    productId: string,
    requestedQty: number,
    variantId?: string
  ): Promise<{
    available: boolean;
    totalAvailable: number;
    shortfall: number;
  }> {
    const stocks = await this.repository.findStockLevels({
      tenantId,
      warehouseId,
      productId,
      variantId,
      includeZeroStock: false,
    });

    const totalAvailable = stocks.reduce(
      (sum, s) => sum + s.quantityAvailable,
      0
    );

    return {
      available: totalAvailable >= requestedQty,
      totalAvailable,
      shortfall: Math.max(0, requestedQty - totalAvailable),
    };
  }

  async getOrCreateStockLevel(
    tenantId: string,
    warehouseId: string,
    productId: string,
    locationId: string,
    variantId?: string,
    lotBatchId?: string
  ): Promise<StockLevel> {
    const existing = await this.repository.getStockLevelForUpdate(
      tenantId,
      productId,
      locationId,
      lotBatchId
    );

    if (existing) {
      return existing;
    }

    return this.repository.upsertStockLevel({
      tenantId,
      warehouseId,
      productId,
      variantId,
      locationId,
      lotBatchId,
      quantityOnHand: 0,
      quantityReserved: 0,
      quantityAvailable: 0,
      quantityInbound: 0,
      quantityOutbound: 0,
      rowVersion: 1,
    });
  }

  async adjustQuantity(
    stockLevelId: string,
    delta: number,
    type: 'on_hand' | 'reserved' | 'inbound' | 'outbound',
    expectedVersion: number
  ): Promise<StockLevel> {
    const deltaMap: Record<string, number> = {};

    switch (type) {
      case 'on_hand':
        deltaMap.onHand = delta;
        break;
      case 'reserved':
        deltaMap.reserved = delta;
        break;
      case 'inbound':
        deltaMap.inbound = delta;
        break;
      case 'outbound':
        deltaMap.outbound = delta;
        break;
    }

    return this.repository.updateQuantities(
      stockLevelId,
      deltaMap,
      expectedVersion
    );
  }
}
