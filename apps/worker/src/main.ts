import { logger, initTracing } from '@stockos/observability';
import { prisma } from '@stockos/db';
import { agentRegistry } from '@stockos/agents';

// Import agents for registration
import {
  StockUpdateAgent,
  ThresholdAgent,
  SlottingAgent,
  ReservationAgent,
  LotExpiryAgent,
  PickWaveAgent,
  PackingAgent,
  ShippingAgent,
  QualityControlAgent,
  QuarantineAgent,
  AbcXyzAgent,
  SafetyStockAgent,
  DemandForecastAgent,
} from '@stockos/agents';

import { OutboxDispatcher } from './outbox-dispatcher.js';
import { EventConsumer } from './consumers/event-consumer.js';
import { SchedulerManager } from './schedulers/scheduler-manager.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const WORKER_MODE = process.env.WORKER_MODE || 'all'; // 'outbox', 'consumer', 'scheduler', 'all'

async function registerAgents() {
  // Register all agents
  agentRegistry.register(new StockUpdateAgent());
  agentRegistry.register(new ThresholdAgent());
  agentRegistry.register(new SlottingAgent());
  agentRegistry.register(new ReservationAgent());
  agentRegistry.register(new LotExpiryAgent());
  agentRegistry.register(new PickWaveAgent());
  agentRegistry.register(new PackingAgent());
  agentRegistry.register(new ShippingAgent());
  agentRegistry.register(new QualityControlAgent());
  agentRegistry.register(new QuarantineAgent());
  agentRegistry.register(new AbcXyzAgent());
  agentRegistry.register(new SafetyStockAgent());
  agentRegistry.register(new DemandForecastAgent());

  logger.info('Registered agents', agentRegistry.getStats());
}

async function main() {
  logger.info('Starting StockOS Worker', { mode: WORKER_MODE });

  // Initialize tracing
  initTracing({
    serviceName: 'stockos-worker',
    serviceVersion: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    enabled: process.env.OTEL_ENABLED === 'true',
  });

  // Register agents
  await registerAgents();

  const components: Array<{ name: string; stop: () => Promise<void> }> = [];

  try {
    // Start Outbox Dispatcher
    if (WORKER_MODE === 'all' || WORKER_MODE === 'outbox') {
      const outboxDispatcher = new OutboxDispatcher({
        rabbitmqUrl: RABBITMQ_URL,
        pollIntervalMs: 1000,
        batchSize: 100,
      });
      await outboxDispatcher.start();
      components.push({
        name: 'OutboxDispatcher',
        stop: () => outboxDispatcher.stop(),
      });
      logger.info('Outbox Dispatcher started');
    }

    // Start Event Consumer
    if (WORKER_MODE === 'all' || WORKER_MODE === 'consumer') {
      const eventConsumer = new EventConsumer({
        rabbitmqUrl: RABBITMQ_URL,
        prefetchCount: 10,
      });
      await eventConsumer.start();
      components.push({
        name: 'EventConsumer',
        stop: () => eventConsumer.stop(),
      });
      logger.info('Event Consumer started');
    }

    // Start Scheduler
    if (WORKER_MODE === 'all' || WORKER_MODE === 'scheduler') {
      const schedulerManager = new SchedulerManager();
      schedulerManager.start();
      components.push({
        name: 'SchedulerManager',
        stop: async () => schedulerManager.stop(),
      });
      logger.info('Scheduler Manager started');
    }

    logger.info('StockOS Worker running', {
      mode: WORKER_MODE,
      components: components.map((c) => c.name),
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      for (const component of components) {
        try {
          await component.stop();
          logger.info(`${component.name} stopped`);
        } catch (error) {
          logger.error(`Failed to stop ${component.name}`, error);
        }
      }

      await prisma.$disconnect();
      logger.info('Worker shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start worker', error);
    process.exit(1);
  }
}

main();
