import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'crypto';
import {
  createContext,
  runWithContextAsync,
  extractContextFromHeaders,
  CORRELATION_HEADERS,
  type RequestContext,
} from '@stockos/observability';
import { createRequestLogger } from '@stockos/observability/logger';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

const correlationPluginAsync: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('ctx', null);

  fastify.addHook('onRequest', async (request, reply) => {
    // Extract context from headers
    const headerContext = extractContextFromHeaders(
      request.headers as Record<string, string | string[] | undefined>
    );

    // Create request context
    const ctx = createContext({
      correlationId: headerContext.correlationId || randomUUID(),
      causationId: headerContext.causationId,
      tenantId: headerContext.tenantId || (request.headers['x-tenant-id'] as string),
      warehouseId: headerContext.warehouseId || (request.headers['x-warehouse-id'] as string),
      requestId: request.id,
    });

    request.ctx = ctx;

    // Set correlation ID in response headers
    reply.header(CORRELATION_HEADERS.CORRELATION_ID, ctx.correlationId);
    reply.header(CORRELATION_HEADERS.REQUEST_ID, ctx.requestId);
  });

  // Wrap request handling in context
  fastify.addHook('preHandler', async (request) => {
    const logger = createRequestLogger(
      request.ctx.correlationId,
      request.ctx.tenantId,
      request.ctx.userId
    );

    logger.info('Request received', {
      method: request.method,
      url: request.url,
      userAgent: request.headers['user-agent'],
    });
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const logger = createRequestLogger(
      request.ctx.correlationId,
      request.ctx.tenantId,
      request.ctx.userId
    );

    logger.info('Request completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    });
  });
};

export const correlationPlugin = fp(correlationPluginAsync, {
  name: 'correlation-plugin',
});
