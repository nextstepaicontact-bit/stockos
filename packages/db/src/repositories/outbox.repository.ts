import type { PrismaClient, OutboxMessage, Prisma } from '@prisma/client';
import type { PrismaTransactionClient } from '../client.js';

export class OutboxRepository {
  constructor(private prisma: PrismaClient | PrismaTransactionClient) {}

  async create(message: Prisma.OutboxMessageCreateInput): Promise<OutboxMessage> {
    return this.prisma.outboxMessage.create({ data: message });
  }

  async createMany(messages: Prisma.OutboxMessageCreateInput[]): Promise<number> {
    const result = await this.prisma.outboxMessage.createMany({
      data: messages as Prisma.OutboxMessageCreateManyInput[],
    });
    return result.count;
  }

  async findPendingMessages(
    limit: number = 100,
    maxRetries: number = 5
  ): Promise<OutboxMessage[]> {
    return this.prisma.outboxMessage.findMany({
      where: {
        status: 'PENDING',
        retryCount: { lt: maxRetries },
        scheduledAt: { lte: new Date() },
      },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
    });
  }

  async markAsPublished(id: string): Promise<OutboxMessage> {
    return this.prisma.outboxMessage.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
  }

  async markAsFailed(id: string, error: string): Promise<OutboxMessage> {
    const message = await this.prisma.outboxMessage.findUnique({
      where: { id },
    });

    if (!message) {
      throw new Error(`OutboxMessage ${id} not found`);
    }

    const newRetryCount = message.retryCount + 1;
    const status = newRetryCount >= message.maxRetries ? 'FAILED' : 'PENDING';

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
    const backoffSeconds = Math.pow(2, newRetryCount);
    const nextSchedule = new Date(Date.now() + backoffSeconds * 1000);

    return this.prisma.outboxMessage.update({
      where: { id },
      data: {
        status,
        retryCount: newRetryCount,
        lastError: error,
        scheduledAt: nextSchedule,
      },
    });
  }

  async getFailedMessages(
    tenantId: string,
    limit: number = 100
  ): Promise<OutboxMessage[]> {
    return this.prisma.outboxMessage.findMany({
      where: {
        tenantId,
        status: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async retryFailedMessage(id: string): Promise<OutboxMessage> {
    return this.prisma.outboxMessage.update({
      where: { id },
      data: {
        status: 'PENDING',
        retryCount: 0,
        lastError: null,
        scheduledAt: new Date(),
      },
    });
  }

  async deleteOldPublishedMessages(
    olderThan: Date
  ): Promise<number> {
    const result = await this.prisma.outboxMessage.deleteMany({
      where: {
        status: 'PUBLISHED',
        publishedAt: { lt: olderThan },
      },
    });
    return result.count;
  }

  async countByStatus(
    tenantId: string
  ): Promise<{ status: string; count: number }[]> {
    const result = await this.prisma.outboxMessage.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { id: true },
    });

    return result.map((r) => ({
      status: r.status,
      count: r._count.id,
    }));
  }
}
