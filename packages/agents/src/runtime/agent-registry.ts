import type { BaseAgent } from './base-agent.js';
import { createLogger } from '@stockos/observability';

const logger = createLogger({ component: 'AgentRegistry' });

export class AgentRegistry {
  private static instance: AgentRegistry;
  private agents: Map<string, BaseAgent> = new Map();
  private eventSubscriptions: Map<string, Set<string>> = new Map();

  private constructor() {}

  static getInstance(): AgentRegistry {
    if (!AgentRegistry.instance) {
      AgentRegistry.instance = new AgentRegistry();
    }
    return AgentRegistry.instance;
  }

  register(agent: BaseAgent): void {
    if (this.agents.has(agent.name)) {
      logger.warn(`Agent ${agent.name} already registered, replacing`);
    }

    this.agents.set(agent.name, agent);

    // Build subscription index
    for (const eventType of agent.subscribesTo) {
      if (!this.eventSubscriptions.has(eventType)) {
        this.eventSubscriptions.set(eventType, new Set());
      }
      this.eventSubscriptions.get(eventType)!.add(agent.name);
    }

    logger.info(`Registered agent: ${agent.name}`, {
      subscribesTo: agent.subscribesTo,
    });
  }

  unregister(agentName: string): void {
    const agent = this.agents.get(agentName);
    if (!agent) return;

    // Remove from subscription index
    for (const eventType of agent.subscribesTo) {
      this.eventSubscriptions.get(eventType)?.delete(agentName);
    }

    this.agents.delete(agentName);
    logger.info(`Unregistered agent: ${agentName}`);
  }

  getAgent(name: string): BaseAgent | undefined {
    return this.agents.get(name);
  }

  getAgentsForEvent(eventType: string): BaseAgent[] {
    const agentNames = new Set<string>();

    // Get agents subscribed to this specific event
    const specificSubs = this.eventSubscriptions.get(eventType);
    if (specificSubs) {
      specificSubs.forEach(name => agentNames.add(name));
    }

    // Get agents subscribed to all events
    const wildcardSubs = this.eventSubscriptions.get('*');
    if (wildcardSubs) {
      wildcardSubs.forEach(name => agentNames.add(name));
    }

    return Array.from(agentNames)
      .map(name => this.agents.get(name))
      .filter((agent): agent is BaseAgent => agent !== undefined);
  }

  getAllAgents(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  getAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  getEventTypes(): string[] {
    return Array.from(this.eventSubscriptions.keys());
  }

  clear(): void {
    this.agents.clear();
    this.eventSubscriptions.clear();
    logger.info('Cleared all agents from registry');
  }

  getStats(): {
    totalAgents: number;
    eventTypes: number;
    subscriptions: Record<string, string[]>;
  } {
    const subscriptions: Record<string, string[]> = {};
    for (const [eventType, agentNames] of this.eventSubscriptions) {
      subscriptions[eventType] = Array.from(agentNames);
    }

    return {
      totalAgents: this.agents.size,
      eventTypes: this.eventSubscriptions.size,
      subscriptions,
    };
  }
}

// Export singleton instance
export const agentRegistry = AgentRegistry.getInstance();
