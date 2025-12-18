import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '@stockos/db';
import { agentRegistry } from '@stockos/agents';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Liveness probe
  fastify.get('/live', {
    schema: {
      description: 'Liveness probe',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // Readiness probe
  fastify.get('/ready', {
    schema: {
      description: 'Readiness probe',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            checks: {
              type: 'object',
              properties: {
                database: { type: 'string' },
                agents: { type: 'string' },
              },
            },
            timestamp: { type: 'string' },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            checks: { type: 'object' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const checks: Record<string, string> = {};
    let allHealthy = true;

    // Check database
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
      allHealthy = false;
    }

    // Check agents
    const agentCount = agentRegistry.getAllAgents().length;
    if (agentCount > 0) {
      checks.agents = `ok (${agentCount} registered)`;
    } else {
      checks.agents = 'warning (no agents)';
    }

    const response = {
      status: allHealthy ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };

    return reply.status(allHealthy ? 200 : 503).send(response);
  });

  // Detailed health info
  fastify.get('/', {
    schema: {
      description: 'Detailed health information',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            version: { type: 'string' },
            uptime: { type: 'number' },
            memory: { type: 'object' },
            agents: { type: 'object' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    const memUsage = process.memoryUsage();

    return {
      status: 'ok',
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
        rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
      },
      agents: agentRegistry.getStats(),
      timestamp: new Date().toISOString(),
    };
  });
};
