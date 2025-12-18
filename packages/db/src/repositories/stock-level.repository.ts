import type { PrismaClient, StockLevel, Prisma } from '@prisma/client';
import type { PrismaTransactionClient } from '../client.js';

export interface StockLevelQuery {
  tenantId: string;
  warehouseId?: string;
  productId?: string;
  variantId?: string;
  locationId?: string;
  lotBatchId?: string;
  includeZeroStock?: boolean;
}

export class StockLevelRepository {
  constructor(private prisma: PrismaClient | PrismaTransactionClient) {}

  async findMany(query: StockLevelQuery): Promise<StockLevel[]> {
    const where: Prisma.StockLevelWhereInput = {
      tenantId: query.tenantId,
    };

    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.productId) where.productId = query.productId;
    if (query.variantId) where.variantId = query.variantId;
    if (query.locationId) where.locationId = query.locationId;
    if (query.lotBatchId) where.lotBatchId = query.lotBatchId;
    if (!query.includeZeroStock) {
      where.quantityOnHand = { gt: 0 };
    }

    return this.prisma.stockLevel.findMany({
      where,
      include: {
        product: {
          select: { sku: true, name: true, abcClass: true, xyzClass: true },
        },
        location: {
          select: { code: true, zone: true, type: true },
        },
        lotBatch: {
          select: { lotNumber: true, expirationDate: true, status: true },
        },
      },
    });
  }

  async findById(id: string): Promise<StockLevel | null> {
    return this.prisma.stockLevel.findUnique({ where: { id } });
  }

  async findForUpdate(
    tenantId: string,
    warehouseId: string,
    productId: string,
    locationId: string,
    lotBatchId?: string
  ): Promise<StockLevel | null> {
    return this.prisma.stockLevel.findFirst({
      where: {
        tenantId,
        warehouseId,
        productId,
        locationId,
        lotBatchId: lotBatchId ?? null,
      },
    });
  }

  async upsert(
    data: Prisma.StockLevelCreateInput
  ): Promise<StockLevel> {
    const existing = await this.prisma.stockLevel.findFirst({
      where: {
        tenantId: (data.tenant as { connect: { id: string } }).connect.id,
        warehouseId: (data.warehouse as { connect: { id: string } }).connect.id,
        productId: (data.product as { connect: { id: string } }).connect.id,
        locationId: (data.location as { connect: { id: string } }).connect.id,
        lotBatchId: data.lotBatch
          ? (data.lotBatch as { connect: { id: string } }).connect.id
          : null,
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.stockLevel.create({ data });
  }

  async updateQuantities(
    id: string,
    delta: {
      onHand?: number;
      reserved?: number;
      inbound?: number;
      outbound?: number;
    },
    expectedVersion: number
  ): Promise<StockLevel> {
    const current = await this.prisma.stockLevel.findUnique({
      where: { id },
    });

    if (!current) {
      throw new Error(`StockLevel ${id} not found`);
    }

    if (current.rowVersion !== expectedVersion) {
      throw new Error(
        `Optimistic lock conflict: expected version ${expectedVersion}, found ${current.rowVersion}`
      );
    }

    const newOnHand = current.quantityOnHand + (delta.onHand ?? 0);
    const newReserved = current.quantityReserved + (delta.reserved ?? 0);

    return this.prisma.stockLevel.update({
      where: { id },
      data: {
        quantityOnHand: newOnHand,
        quantityReserved: newReserved,
        quantityAvailable: newOnHand - newReserved,
        quantityInbound: current.quantityInbound + (delta.inbound ?? 0),
        quantityOutbound: current.quantityOutbound + (delta.outbound ?? 0),
        lastMovementAt: new Date(),
        rowVersion: { increment: 1 },
      },
    });
  }

  async decrementOnHand(
    id: string,
    quantity: number,
    expectedVersion: number
  ): Promise<StockLevel> {
    return this.updateQuantities(id, { onHand: -quantity }, expectedVersion);
  }

  async incrementOnHand(
    id: string,
    quantity: number,
    expectedVersion: number
  ): Promise<StockLevel> {
    return this.updateQuantities(id, { onHand: quantity }, expectedVersion);
  }

  async reserve(
    id: string,
    quantity: number,
    expectedVersion: number
  ): Promise<StockLevel> {
    return this.updateQuantities(id, { reserved: quantity }, expectedVersion);
  }

  async unreserve(
    id: string,
    quantity: number,
    expectedVersion: number
  ): Promise<StockLevel> {
    return this.updateQuantities(id, { reserved: -quantity }, expectedVersion);
  }
}
