import type { PrismaClient, Movement, Prisma } from '@prisma/client';
import type { PrismaTransactionClient } from '../client.js';

export class MovementRepository {
  constructor(private prisma: PrismaClient | PrismaTransactionClient) {}

  async create(data: Prisma.MovementCreateInput): Promise<Movement> {
    return this.prisma.movement.create({ data });
  }

  async findById(id: string): Promise<Movement | null> {
    return this.prisma.movement.findUnique({ where: { id } });
  }

  async findByReference(
    tenantId: string,
    referenceType: string,
    referenceId: string
  ): Promise<Movement[]> {
    return this.prisma.movement.findMany({
      where: {
        tenantId,
        referenceType,
        referenceId,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findByProduct(
    tenantId: string,
    productId: string,
    options?: {
      warehouseId?: string;
      startDate?: Date;
      endDate?: Date;
      movementTypes?: string[];
      limit?: number;
      offset?: number;
    }
  ): Promise<Movement[]> {
    const where: Prisma.MovementWhereInput = {
      tenantId,
      productId,
    };

    if (options?.warehouseId) where.warehouseId = options.warehouseId;
    if (options?.movementTypes?.length) {
      where.movementType = { in: options.movementTypes };
    }
    if (options?.startDate || options?.endDate) {
      where.createdAt = {};
      if (options?.startDate) where.createdAt.gte = options.startDate;
      if (options?.endDate) where.createdAt.lte = options.endDate;
    }

    return this.prisma.movement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 100,
      skip: options?.offset ?? 0,
    });
  }

  async findByLocation(
    tenantId: string,
    locationId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    }
  ): Promise<Movement[]> {
    const where: Prisma.MovementWhereInput = {
      tenantId,
      OR: [{ fromLocationId: locationId }, { toLocationId: locationId }],
    };

    if (options?.startDate || options?.endDate) {
      where.createdAt = {};
      if (options?.startDate) where.createdAt.gte = options.startDate;
      if (options?.endDate) where.createdAt.lte = options.endDate;
    }

    return this.prisma.movement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 100,
    });
  }

  async countByType(
    tenantId: string,
    warehouseId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ movementType: string; count: number }[]> {
    const result = await this.prisma.movement.groupBy({
      by: ['movementType'],
      where: {
        tenantId,
        warehouseId,
        createdAt: { gte: startDate, lte: endDate },
      },
      _count: { id: true },
    });

    return result.map((r) => ({
      movementType: r.movementType,
      count: r._count.id,
    }));
  }

  async sumQuantityByType(
    tenantId: string,
    productId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ movementType: string; totalQuantity: number }[]> {
    const result = await this.prisma.movement.groupBy({
      by: ['movementType'],
      where: {
        tenantId,
        productId,
        createdAt: { gte: startDate, lte: endDate },
      },
      _sum: { quantity: true },
    });

    return result.map((r) => ({
      movementType: r.movementType,
      totalQuantity: r._sum.quantity ?? 0,
    }));
  }
}
