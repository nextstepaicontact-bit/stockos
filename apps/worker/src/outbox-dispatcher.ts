import * as amqp from 'amqplib';
import { logger } from '@stockos/observability';
import { prisma } from '@stockos/db';
import { OutboxRepository } from '@stockos/db/repositories';
import { outboxQueueSize, outboxPublishLatency } from '@stockos/observability/metrics';

export interface OutboxDispatcherConfig {
  rabbitmqUrl: string;
  pollIntervalMs: number;
  batchSize: number;
}

export class OutboxDispatcher {
  private config: OutboxDispatcherConfig;
  private connection: amqp.Connection | null = null;
  private channel: amqp.Channel | null = null;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: OutboxDispatcherConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    // Connect to RabbitMQ
    this.connection = await amqp.connect(this.config.rabbitmqUrl);
    this.channel = await this.connection.createChannel();

    // Declare exchange
    await this.channel.assertExchange('stockos.events', 'topic', {
      durable: true,
    });

    this.isRunning = true;
    this.poll();

    logger.info('Outbox Dispatcher connected to RabbitMQ');
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    if (this.channel) {
      await this.channel.close();
    }

    if (this.connection) {
      await this.connection.close();
    }
  }

  private poll(): void {
    if (!this.isRunning) return;

    this.processOutbox()
      .catch((error) => {
        logger.error('Outbox processing error', error);
      })
      .finally(() => {
        if (this.isRunning) {
          this.pollTimer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
        }
      });
  }

  private async processOutbox(): Promise<void> {
    const repo = new OutboxRepository(prisma);

    // Get pending messages
    const messages = await repo.findPendingMessages(this.config.batchSize);

    if (messages.length === 0) return;

    // Update metrics
    outboxQueueSize.set({ status: 'pending' }, messages.length);

    for (const message of messages) {
      try {
        if (!this.channel) {
          throw new Error('Channel not available');
        }

        // Publish to RabbitMQ
        const published = this.channel.publish(
          'stockos.events',
          message.routingKey,
          Buffer.from(JSON.stringify(message.payload)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: message.eventId,
            headers: {
              'x-tenant-id': message.tenantId,
              'x-event-type': message.eventType,
            },
          }
        );

        if (published) {
          await repo.markAsPublished(message.id);

          // Record latency
          const latencyMs = Date.now() - message.createdAt.getTime();
          outboxPublishLatency.observe(latencyMs / 1000);

          logger.debug('Published message', {
            eventId: message.eventId,
            eventType: message.eventType,
            routingKey: message.routingKey,
            latencyMs,
          });
        } else {
          logger.warn('Channel returned false for publish', {
            eventId: message.eventId,
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await repo.markAsFailed(message.id, errorMessage);

        logger.error('Failed to publish message', error, {
          eventId: message.eventId,
          retryCount: message.retryCount + 1,
        });
      }
    }
  }
}
