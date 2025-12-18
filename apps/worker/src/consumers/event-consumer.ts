import * as amqp from 'amqplib';
import { logger, createLogger } from '@stockos/observability';
import { agentRunner } from '@stockos/agents';
import type { EventEnvelope } from '@stockos/contracts';

export interface EventConsumerConfig {
  rabbitmqUrl: string;
  prefetchCount: number;
}

export class EventConsumer {
  private config: EventConsumerConfig;
  private connection: amqp.Connection | null = null;
  private channel: amqp.Channel | null = null;
  private consumerTag: string | null = null;

  constructor(config: EventConsumerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    // Connect to RabbitMQ
    this.connection = await amqp.connect(this.config.rabbitmqUrl);
    this.channel = await this.connection.createChannel();

    // Set prefetch
    await this.channel.prefetch(this.config.prefetchCount);

    // Declare exchange
    await this.channel.assertExchange('stockos.events', 'topic', {
      durable: true,
    });

    // Declare queue
    const queue = await this.channel.assertQueue('stockos.agent-processor', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'stockos.events.dlx',
        'x-dead-letter-routing-key': 'dead-letter',
      },
    });

    // Bind to all events
    await this.channel.bindQueue(queue.queue, 'stockos.events', '#');

    // Declare DLX
    await this.channel.assertExchange('stockos.events.dlx', 'direct', {
      durable: true,
    });

    await this.channel.assertQueue('stockos.events.dlq', {
      durable: true,
    });

    await this.channel.bindQueue(
      'stockos.events.dlq',
      'stockos.events.dlx',
      'dead-letter'
    );

    // Start consuming
    const consumer = await this.channel.consume(
      queue.queue,
      (msg) => this.handleMessage(msg),
      { noAck: false }
    );

    this.consumerTag = consumer.consumerTag;

    logger.info('Event Consumer started', {
      queue: queue.queue,
      prefetch: this.config.prefetchCount,
    });
  }

  async stop(): Promise<void> {
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag);
    }

    if (this.channel) {
      await this.channel.close();
    }

    if (this.connection) {
      await this.connection.close();
    }
  }

  private async handleMessage(msg: amqp.ConsumeMessage | null): Promise<void> {
    if (!msg || !this.channel) return;

    const messageLogger = createLogger({ component: 'EventConsumer' });

    try {
      // Parse event
      const event: EventEnvelope = JSON.parse(msg.content.toString());

      messageLogger.info('Processing event', {
        eventId: event.event_id,
        eventType: event.event_type,
        correlationId: event.correlation_id,
      });

      // Execute agents for this event
      const result = await agentRunner.executeForEvent(event, {
        tenantId: event.tenant_id,
        warehouseId: event.warehouse_id,
        correlationId: event.correlation_id,
      });

      // Log results
      messageLogger.info('Event processed', {
        eventId: event.event_id,
        eventType: event.event_type,
        successCount: result.successCount,
        failureCount: result.failureCount,
        eventsGenerated: result.eventsToPublish.length,
        duration: result.totalDuration,
      });

      // Publish generated events back to the exchange
      if (result.eventsToPublish.length > 0) {
        for (const newEvent of result.eventsToPublish) {
          const routingKey = `${newEvent.event_type.toLowerCase().replace(/_/g, '.')}`;

          this.channel.publish(
            'stockos.events',
            routingKey,
            Buffer.from(JSON.stringify(newEvent)),
            {
              persistent: true,
              contentType: 'application/json',
              messageId: newEvent.event_id,
              headers: {
                'x-tenant-id': newEvent.tenant_id,
                'x-event-type': newEvent.event_type,
                'x-correlation-id': newEvent.correlation_id,
                'x-causation-id': event.event_id,
              },
            }
          );
        }

        messageLogger.debug('Published derived events', {
          count: result.eventsToPublish.length,
          types: result.eventsToPublish.map((e) => e.event_type),
        });
      }

      // Acknowledge message
      this.channel.ack(msg);
    } catch (error) {
      messageLogger.error('Failed to process message', error, {
        messageId: msg.properties.messageId,
      });

      // Check retry count
      const retryCount = (msg.properties.headers?.['x-retry-count'] as number) ?? 0;

      if (retryCount < 3) {
        // Requeue with delay (using dead letter exchange with TTL would be better)
        setTimeout(() => {
          if (this.channel) {
            this.channel.nack(msg, false, true);
          }
        }, Math.pow(2, retryCount) * 1000);
      } else {
        // Send to DLQ
        this.channel.nack(msg, false, false);
        messageLogger.warn('Message sent to DLQ after max retries', {
          messageId: msg.properties.messageId,
          retryCount,
        });
      }
    }
  }
}
