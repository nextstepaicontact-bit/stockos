import type { EventEnvelope } from '@stockos/contracts';
import type { AgentContext, AgentResult, BaseAgent } from './base-agent.js';
import { agentRegistry } from './agent-registry.js';
import { createLogger, Logger } from '@stockos/observability';
import { withSpan } from '@stockos/observability/tracing';

export interface AgentRunnerConfig {
  concurrency?: number;
  continueOnError?: boolean;
  timeout?: number;
}

export interface AgentExecutionResult {
  agentName: string;
  result: AgentResult;
  duration: number;
}

export interface BatchExecutionResult {
  eventId: string;
  eventType: string;
  results: AgentExecutionResult[];
  totalDuration: number;
  successCount: number;
  failureCount: number;
  eventsToPublish: EventEnvelope[];
}

const DEFAULT_CONFIG: AgentRunnerConfig = {
  concurrency: 10,
  continueOnError: true,
  timeout: 30000,
};

export class AgentRunner {
  private config: Required<AgentRunnerConfig>;
  private logger: Logger;

  constructor(config: Partial<AgentRunnerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<AgentRunnerConfig>;
    this.logger = createLogger({ component: 'AgentRunner' });
  }

  async executeForEvent(
    event: EventEnvelope,
    context: Omit<AgentContext, 'logger'>
  ): Promise<BatchExecutionResult> {
    const startTime = Date.now();
    const agents = agentRegistry.getAgentsForEvent(event.event_type);

    const runnerLogger = this.logger.child({
      eventId: event.event_id,
      eventType: event.event_type,
      correlationId: context.correlationId,
    });

    runnerLogger.info(`Found ${agents.length} agents for event`, {
      agents: agents.map(a => a.name),
    });

    if (agents.length === 0) {
      return {
        eventId: event.event_id,
        eventType: event.event_type,
        results: [],
        totalDuration: 0,
        successCount: 0,
        failureCount: 0,
        eventsToPublish: [],
      };
    }

    const results = await this.executeAgents(agents, event, {
      ...context,
      logger: runnerLogger,
    });

    const totalDuration = Date.now() - startTime;
    const successCount = results.filter(r => r.result.success).length;
    const failureCount = results.filter(r => !r.result.success).length;

    // Collect all events to publish
    const eventsToPublish = results.flatMap(
      r => r.result.eventsToPublish ?? []
    );

    runnerLogger.info(`Completed event processing`, {
      totalDuration,
      successCount,
      failureCount,
      eventsGenerated: eventsToPublish.length,
    });

    return {
      eventId: event.event_id,
      eventType: event.event_type,
      results,
      totalDuration,
      successCount,
      failureCount,
      eventsToPublish,
    };
  }

  private async executeAgents(
    agents: BaseAgent[],
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentExecutionResult[]> {
    return withSpan(
      'agent-runner.execute-batch',
      async () => {
        const results: AgentExecutionResult[] = [];

        // Execute in batches based on concurrency
        for (let i = 0; i < agents.length; i += this.config.concurrency) {
          const batch = agents.slice(i, i + this.config.concurrency);
          const batchResults = await Promise.all(
            batch.map(agent => this.executeAgent(agent, event, context))
          );

          results.push(...batchResults);

          // Check if we should stop on error
          if (!this.config.continueOnError) {
            const hasError = batchResults.some(r => !r.result.success);
            if (hasError) {
              this.logger.warn('Stopping execution due to agent error');
              break;
            }
          }
        }

        return results;
      },
      {
        tenantId: context.tenantId,
        correlationId: context.correlationId,
        attributes: {
          'agents.count': agents.length,
          'event.type': event.event_type,
        },
      }
    );
  }

  private async executeAgent(
    agent: BaseAgent,
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentExecutionResult> {
    const startTime = Date.now();

    try {
      // Add timeout wrapper
      const result = await Promise.race([
        agent.handle(event, context),
        this.createTimeout(agent.name),
      ]);

      return {
        agentName: agent.name,
        result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        agentName: agent.name,
        result: {
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error',
          errors: [error instanceof Error ? error.message : 'Unknown error'],
        },
        duration: Date.now() - startTime,
      };
    }
  }

  private createTimeout(agentName: string): Promise<AgentResult> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Agent ${agentName} timed out after ${this.config.timeout}ms`));
      }, this.config.timeout);
    });
  }

  async executeAgent(
    agentName: string,
    event: EventEnvelope,
    context: Omit<AgentContext, 'logger'>
  ): Promise<AgentExecutionResult | null> {
    const agent = agentRegistry.getAgent(agentName);
    if (!agent) {
      this.logger.warn(`Agent ${agentName} not found`);
      return null;
    }

    return this.executeAgents([agent], event, {
      ...context,
      logger: this.logger,
    }).then(results => results[0]);
  }
}

// Export singleton instance
export const agentRunner = new AgentRunner();
