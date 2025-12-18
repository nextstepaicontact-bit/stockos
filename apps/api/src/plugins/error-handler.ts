import type { FastifyPluginAsync, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { DomainError } from '@stockos/contracts';
import { createRequestLogger } from '@stockos/observability/logger';

interface ErrorResponse {
  error_code: string;
  message: string;
  message_fr?: string;
  details?: Record<string, unknown>;
  remediation?: string;
  retriable: boolean;
  http_status: number;
  correlation_id: string;
  timestamp: string;
}

const errorHandlerPluginAsync: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    const correlationId = request.ctx?.correlationId || 'unknown';
    const logger = createRequestLogger(correlationId, request.ctx?.tenantId);

    // Handle Domain Errors
    if (error instanceof DomainError) {
      const response = error.toResponse(correlationId);

      logger.warn('Domain error', {
        errorCode: error.errorCode.code,
        message: error.message,
        details: error.details,
      });

      return reply.status(error.errorCode.http).send(response);
    }

    // Handle Zod Validation Errors
    if (error.name === 'ZodError') {
      const zodError = error as unknown as { issues: Array<{ path: string[]; message: string }> };

      const response: ErrorResponse = {
        error_code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        message_fr: 'Validation de la requête échouée',
        details: {
          issues: zodError.issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        retriable: false,
        http_status: 400,
        correlation_id: correlationId,
        timestamp: new Date().toISOString(),
      };

      logger.warn('Validation error', { issues: zodError.issues });

      return reply.status(400).send(response);
    }

    // Handle Fastify Errors (validation, etc.)
    if ((error as FastifyError).validation) {
      const fastifyError = error as FastifyError;

      const response: ErrorResponse = {
        error_code: 'VALIDATION_FAILED',
        message: fastifyError.message,
        retriable: false,
        http_status: 400,
        correlation_id: correlationId,
        timestamp: new Date().toISOString(),
      };

      logger.warn('Fastify validation error', { message: fastifyError.message });

      return reply.status(400).send(response);
    }

    // Handle Rate Limit Errors
    if ((error as FastifyError).statusCode === 429) {
      const response: ErrorResponse = {
        error_code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests',
        message_fr: 'Trop de requêtes',
        retriable: true,
        http_status: 429,
        correlation_id: correlationId,
        timestamp: new Date().toISOString(),
      };

      logger.warn('Rate limit exceeded', { ip: request.ip });

      return reply.status(429).send(response);
    }

    // Handle Unknown Errors
    logger.error('Unhandled error', error, {
      method: request.method,
      url: request.url,
    });

    const response: ErrorResponse = {
      error_code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
      message_fr: 'Une erreur interne est survenue',
      retriable: true,
      http_status: 500,
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
    };

    return reply.status(500).send(response);
  });

  // Handle 404s
  fastify.setNotFoundHandler((request, reply) => {
    const correlationId = request.ctx?.correlationId || 'unknown';

    const response: ErrorResponse = {
      error_code: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
      message_fr: `Route ${request.method} ${request.url} non trouvée`,
      retriable: false,
      http_status: 404,
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
    };

    return reply.status(404).send(response);
  });
};

export const errorHandlerPlugin = fp(errorHandlerPluginAsync, {
  name: 'error-handler-plugin',
});
