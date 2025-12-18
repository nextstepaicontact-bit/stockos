export interface StockLevel {
  id: string;
  tenantId: string;
  warehouseId: string;
  productId: string;
  variantId?: string;
  locationId: string;
  lotBatchId?: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
  quantityInbound: number;
  quantityOutbound: number;
  lastMovementAt?: Date;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockLevelWithDetails extends StockLevel {
  product?: {
    sku: string;
    name: string;
    abcClass?: string;
    xyzClass?: string;
  };
  location?: {
    code: string;
    zone: string;
    type: string;
  };
  lotBatch?: {
    lotNumber: string;
    expirationDate?: Date;
    status: string;
  };
}

export function calculateAvailableQuantity(
  onHand: number,
  reserved: number
): number {
  return Math.max(0, onHand - reserved);
}

export function canFulfillQuantity(
  stockLevel: StockLevel,
  requestedQty: number,
  allowNegative: boolean = false
): boolean {
  if (allowNegative) return true;
  return stockLevel.quantityAvailable >= requestedQty;
}
