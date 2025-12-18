import type { EventEnvelope } from '@stockos/contracts';
import { Logger, createLogger } from '@stockos/observability';
import { recordAgentExecution } from '@stockos/observability/metrics';
import { withSpan } from '@stockos/observability/tracing';

export interface AgentContext {
  tenantId: string;
  warehouseId?: string;
  correlationId: string;
  logger: Logger;
}

export interface AgentResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
  eventsToPublish?: EventEnvelope[];
  errors?: string[];
}

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly subscribesTo: string[];

  protected logger: Logger;

  constructor() {
    this.logger = createLogger({ agent: this.name });
  }

  async handle(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const agentLogger = context.logger.child({ agent: this.name });

    try {
      agentLogger.info(`Processing event`, {
        eventType: event.event_type,
        eventId: event.event_id,
      });

      const result = await withSpan(
        `agent.${this.name}.handle`,
        async () => this.process(event, { ...context, logger: agentLogger }),
        {
          tenantId: context.tenantId,
          correlationId: context.correlationId,
          attributes: {
            'agent.name': this.name,
            'event.type': event.event_type,
            'event.id': event.event_id,
          },
        }
      );

      const duration = (Date.now() - startTime) / 1000;
      recordAgentExecution(this.name, result.success ? 'success' : 'failure', duration);

      agentLogger.info(`Completed processing`, {
        success: result.success,
        duration,
        eventsGenerated: result.eventsToPublish?.length ?? 0,
      });

      return result;
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      recordAgentExecution(this.name, 'failure', duration);

      agentLogger.error('Failed to process event', error, {
        eventType: event.event_type,
        eventId: event.event_id,
      });

      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }

  protected abstract process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult>;

  protected createSuccessResult(
    message: string,
    data?: Record<string, unknown>,
    eventsToPublish?: EventEnvelope[]
  ): AgentResult {
    return {
      success: true,
      message,
      data,
      eventsToPublish,
    };
  }

  protected createFailureResult(
    message: string,
    errors?: string[]
  ): AgentResult {
    return {
      success: false,
      message,
      errors,
    };
  }

  protected shouldHandle(eventType: string): boolean {
    return this.subscribesTo.includes(eventType) || this.subscribesTo.includes('*');
  }
}
