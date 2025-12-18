import { z } from 'zod';
import { randomUUID } from 'crypto';

export const ActorSchema = z.object({
  type: z.enum(['USER', 'SYSTEM', 'AGENT', 'INTEGRATION']),
  id: z.string().min(1),
  roles: z.array(z.string()).optional(),
});

export const EventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.string().regex(/^[A-Z][a-zA-Z]+\.[A-Z][a-zA-Z]+$/),
  occurred_at: z.string().datetime(),
  schema_version: z.string().regex(/^\d+\.\d+$/),
  correlation_id: z.string().uuid(),
  causation_id: z.string().uuid().optional(),
  actor: ActorSchema,
  tenant_id: z.string().uuid(),
  warehouse_id: z.string().uuid().optional(),
  payload: z.record(z.unknown()),
});

export type Actor = z.infer<typeof ActorSchema>;
export type EventEnvelope<T = Record<string, unknown>> = Omit<
  z.infer<typeof EventEnvelopeSchema>,
  'payload'
> & {
  payload: T;
};

export function createEvent<T extends Record<string, unknown>>(
  eventType: string,
  payload: T,
  context: {
    correlationId: string;
    causationId?: string;
    actor: Actor;
    tenantId: string;
    warehouseId?: string;
  }
): EventEnvelope<T> {
  return {
    event_id: randomUUID(),
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    schema_version: '1.0',
    correlation_id: context.correlationId,
    causation_id: context.causationId,
    actor: context.actor,
    tenant_id: context.tenantId,
    warehouse_id: context.warehouseId,
    payload,
  };
}
