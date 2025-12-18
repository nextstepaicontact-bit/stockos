import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

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

import { correlationPlugin } from './plugins/correlation.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { metricsPlugin } from './plugins/metrics.js';

import { healthRoutes } from './routes/health.js';
import { inventoryRoutes } from './routes/inventory.js';
import { movementRoutes } from './routes/movements.js';
import { receivingRoutes } from './routes/receiving.js';
import { ordersRoutes } from './routes/orders.js';
import { productsRoutes } from './routes/products.js';
import { locationsRoutes } from './routes/locations.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function buildApp() {
  const app = Fastify({
    logger: false, // We use our own logger
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
  });

  // Security plugins
  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      return request.headers['x-tenant-id'] as string || request.ip;
    },
  });

  // Swagger documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'StockOS API',
        description: 'Multi-agent WMS/Inventory Management API',
        version: '1.0.0',
      },
      servers: [
        { url: `http://localhost:${PORT}`, description: 'Development' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
          tenantId: {
            type: 'apiKey',
            in: 'header',
            name: 'x-tenant-id',
          },
        },
      },
      security: [{ bearerAuth: [], tenantId: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });

  // Custom plugins
  await app.register(correlationPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(metricsPlugin);

  // Routes
  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(inventoryRoutes, { prefix: '/api/v1/inventory' });
  await app.register(movementRoutes, { prefix: '/api/v1/movements' });
  await app.register(receivingRoutes, { prefix: '/api/v1/receiving' });
  await app.register(ordersRoutes, { prefix: '/api/v1/orders' });
  await app.register(productsRoutes, { prefix: '/api/v1/products' });
  await app.register(locationsRoutes, { prefix: '/api/v1/locations' });

  return app;
}

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

async function start() {
  try {
    // Initialize tracing
    initTracing({
      serviceName: 'stockos-api',
      serviceVersion: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      enabled: process.env.OTEL_ENABLED === 'true',
    });

    // Register agents
    await registerAgents();

    // Build and start server
    const app = await buildApp();

    await app.listen({ port: PORT, host: HOST });
    logger.info(`Server running at http://${HOST}:${PORT}`);
    logger.info(`API docs at http://${HOST}:${PORT}/docs`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      await app.close();
      await prisma.$disconnect();

      logger.info('Server closed');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

start();
