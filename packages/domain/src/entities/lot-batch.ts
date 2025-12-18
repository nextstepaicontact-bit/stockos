export type LotStatus = 'AVAILABLE' | 'QUARANTINE' | 'EXPIRED' | 'HOLD' | 'RELEASED';

export interface LotBatch {
  id: string;
  tenantId: string;
  productId: string;
  lotNumber: string;
  batchNumber?: string;
  expirationDate?: Date;
  manufactureDate?: Date;
  receivedAt: Date;
  supplierId?: string;
  status: LotStatus;
  certificateOfAnalysis?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export function isLotExpired(lot: LotBatch, referenceDate: Date = new Date()): boolean {
  if (!lot.expirationDate) return false;
  return lot.expirationDate < referenceDate;
}

export function isLotAvailable(lot: LotBatch, referenceDate: Date = new Date()): boolean {
  if (lot.status !== 'AVAILABLE' && lot.status !== 'RELEASED') return false;
  return !isLotExpired(lot, referenceDate);
}

export function getDaysUntilExpiration(lot: LotBatch, referenceDate: Date = new Date()): number | null {
  if (!lot.expirationDate) return null;
  const diffMs = lot.expirationDate.getTime() - referenceDate.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export function compareLotsByFEFO(a: LotBatch, b: LotBatch): number {
  // FEFO: First Expired First Out
  // Lots without expiration date come last
  if (!a.expirationDate && !b.expirationDate) {
    // Both have no expiration, use received date (FIFO)
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  }
  if (!a.expirationDate) return 1;
  if (!b.expirationDate) return -1;
  return a.expirationDate.getTime() - b.expirationDate.getTime();
}
