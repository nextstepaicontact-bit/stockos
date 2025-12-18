import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ActorSchema, type Actor } from '../events/envelope.js';

export const CommandEnvelopeSchema = z.object({
  command_id: z.string().uuid(),
  command_type: z.string(),
  requested_at: z.string().datetime(),
  idempotency_key: z.string().max(255),
  correlation_id: z.string().uuid(),
  causation_id: z.string().uuid().optional(),
  actor: ActorSchema,
  tenant_id: z.string().uuid(),
  payload: z.record(z.unknown()),
});

export type CommandEnvelope<T = Record<string, unknown>> = Omit<
  z.infer<typeof CommandEnvelopeSchema>,
  'payload'
> & {
  payload: T;
};

export function createCommand<T extends Record<string, unknown>>(
  commandType: string,
  payload: T,
  context: {
    idempotencyKey: string;
    correlationId: string;
    causationId?: string;
    actor: Actor;
    tenantId: string;
  }
): CommandEnvelope<T> {
  return {
    command_id: randomUUID(),
    command_type: commandType,
    requested_at: new Date().toISOString(),
    idempotency_key: context.idempotencyKey,
    correlation_id: context.correlationId,
    causation_id: context.causationId,
    actor: context.actor,
    tenant_id: context.tenantId,
    payload,
  };
}
