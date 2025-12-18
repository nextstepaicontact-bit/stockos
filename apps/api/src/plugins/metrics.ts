import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import {
  httpRequestsTotal,
  httpRequestDuration,
  getMetrics,
  getContentType,
} from '@stockos/observability/metrics';

const metricsPluginAsync: FastifyPluginAsync = async (fastify) => {
  // Track request metrics
  fastify.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url || request.url;
    const method = request.method;
    const statusCode = reply.statusCode.toString();
    const tenantId = request.ctx?.tenantId || 'unknown';

    // Increment request counter
    httpRequestsTotal.inc({
      method,
      route,
      status_code: statusCode,
      tenant_id: tenantId,
    });

    // Record duration
    if (reply.elapsedTime) {
      httpRequestDuration.observe(
        {
          method,
          route,
          status_code: statusCode,
        },
        reply.elapsedTime / 1000 // Convert to seconds
      );
    }
  });

  // Metrics endpoint
  fastify.get('/metrics', async (request, reply) => {
    const metrics = await getMetrics();
    reply.header('Content-Type', getContentType());
    return metrics;
  });
};

export const metricsPlugin = fp(metricsPluginAsync, {
  name: 'metrics-plugin',
});
