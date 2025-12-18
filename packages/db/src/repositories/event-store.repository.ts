import type { PrismaClient, EventStore, Prisma } from '@prisma/client';
import type { PrismaTransactionClient } from '../client.js';

export interface EventQuery {
  tenantId: string;
  aggregateType?: string;
  aggregateId?: string;
  eventTypes?: string[];
  correlationId?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

export class EventStoreRepository {
  constructor(private prisma: PrismaClient | PrismaTransactionClient) {}

  async append(event: Prisma.EventStoreCreateInput): Promise<EventStore> {
    return this.prisma.eventStore.create({ data: event });
  }

  async appendMany(events: Prisma.EventStoreCreateInput[]): Promise<number> {
    const result = await this.prisma.eventStore.createMany({
      data: events as Prisma.EventStoreCreateManyInput[],
    });
    return result.count;
  }

  async findByEventId(eventId: string): Promise<EventStore | null> {
    return this.prisma.eventStore.findUnique({
      where: { eventId },
    });
  }

  async findByAggregate(
    tenantId: string,
    aggregateType: string,
    aggregateId: string
  ): Promise<EventStore[]> {
    return this.prisma.eventStore.findMany({
      where: {
        tenantId,
        aggregateType,
        aggregateId,
      },
      orderBy: { occurredAt: 'asc' },
    });
  }

  async query(query: EventQuery): Promise<EventStore[]> {
    const where: Prisma.EventStoreWhereInput = {
      tenantId: query.tenantId,
    };

    if (query.aggregateType) where.aggregateType = query.aggregateType;
    if (query.aggregateId) where.aggregateId = query.aggregateId;
    if (query.correlationId) where.correlationId = query.correlationId;
    if (query.eventTypes?.length) {
      where.eventType = { in: query.eventTypes };
    }
    if (query.fromDate || query.toDate) {
      where.occurredAt = {};
      if (query.fromDate) where.occurredAt.gte = query.fromDate;
      if (query.toDate) where.occurredAt.lte = query.toDate;
    }

    return this.prisma.eventStore.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
  }

  async countByType(
    tenantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ eventType: string; count: number }[]> {
    const result = await this.prisma.eventStore.groupBy({
      by: ['eventType'],
      where: {
        tenantId,
        occurredAt: { gte: startDate, lte: endDate },
      },
      _count: { id: true },
    });

    return result.map((r) => ({
      eventType: r.eventType,
      count: r._count.id,
    }));
  }

  async getLatestEventForAggregate(
    tenantId: string,
    aggregateType: string,
    aggregateId: string
  ): Promise<EventStore | null> {
    return this.prisma.eventStore.findFirst({
      where: {
        tenantId,
        aggregateType,
        aggregateId,
      },
      orderBy: { occurredAt: 'desc' },
    });
  }
}
