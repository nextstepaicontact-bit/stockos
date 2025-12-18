import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

// Create a custom registry
export const metricsRegistry = new Registry();

// Collect default Node.js metrics
collectDefaultMetrics({ register: metricsRegistry });

// ============================================================================
// HTTP Metrics
// ============================================================================

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'tenant_id'],
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// ============================================================================
// Business Metrics - Inventory
// ============================================================================

export const movementsTotal = new Counter({
  name: 'stockos_movements_total',
  help: 'Total number of inventory movements',
  labelNames: ['movement_type', 'warehouse_id', 'tenant_id'],
  registers: [metricsRegistry],
});

export const movementQuantity = new Counter({
  name: 'stockos_movement_quantity_total',
  help: 'Total quantity of items moved',
  labelNames: ['movement_type', 'warehouse_id', 'tenant_id'],
  registers: [metricsRegistry],
});

export const stockLevelsGauge = new Gauge({
  name: 'stockos_stock_level_units',
  help: 'Current stock levels in units',
  labelNames: ['warehouse_id', 'product_id', 'type'],
  registers: [metricsRegistry],
});

export const reservationsActive = new Gauge({
  name: 'stockos_reservations_active',
  help: 'Number of active reservations',
  labelNames: ['warehouse_id', 'tenant_id'],
  registers: [metricsRegistry],
});

export const lowStockAlerts = new Gauge({
  name: 'stockos_low_stock_alerts',
  help: 'Number of products below reorder point',
  labelNames: ['warehouse_id', 'tenant_id'],
  registers: [metricsRegistry],
});

export const expiringLots = new Gauge({
  name: 'stockos_expiring_lots',
  help: 'Number of lots expiring within threshold days',
  labelNames: ['warehouse_id', 'tenant_id', 'days_threshold'],
  registers: [metricsRegistry],
});

// ============================================================================
// Business Metrics - Orders
// ============================================================================

export const ordersTotal = new Counter({
  name: 'stockos_orders_total',
  help: 'Total number of orders processed',
  labelNames: ['order_type', 'status', 'tenant_id'],
  registers: [metricsRegistry],
});

export const orderFulfillmentRate = new Gauge({
  name: 'stockos_order_fulfillment_rate',
  help: 'Order fulfillment rate (0-1)',
  labelNames: ['warehouse_id', 'tenant_id'],
  registers: [metricsRegistry],
});

export const orderProcessingDuration = new Histogram({
  name: 'stockos_order_processing_duration_seconds',
  help: 'Time to process orders in seconds',
  labelNames: ['order_type', 'tenant_id'],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

// ============================================================================
// System Metrics - Events & Commands
// ============================================================================

export const eventsPublished = new Counter({
  name: 'stockos_events_published_total',
  help: 'Total number of events published',
  labelNames: ['event_type', 'tenant_id'],
  registers: [metricsRegistry],
});

export const commandsProcessed = new Counter({
  name: 'stockos_commands_processed_total',
  help: 'Total number of commands processed',
  labelNames: ['command_type', 'status', 'tenant_id'],
  registers: [metricsRegistry],
});

export const commandProcessingDuration = new Histogram({
  name: 'stockos_command_processing_duration_seconds',
  help: 'Command processing duration in seconds',
  labelNames: ['command_type'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const outboxQueueSize = new Gauge({
  name: 'stockos_outbox_queue_size',
  help: 'Number of messages in outbox queue',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const outboxPublishLatency = new Histogram({
  name: 'stockos_outbox_publish_latency_seconds',
  help: 'Latency between event creation and outbox publish',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

// ============================================================================
// System Metrics - Agents
// ============================================================================

export const agentExecutions = new Counter({
  name: 'stockos_agent_executions_total',
  help: 'Total agent executions',
  labelNames: ['agent_name', 'status'],
  registers: [metricsRegistry],
});

export const agentExecutionDuration = new Histogram({
  name: 'stockos_agent_execution_duration_seconds',
  help: 'Agent execution duration in seconds',
  labelNames: ['agent_name'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

// ============================================================================
// Database Metrics
// ============================================================================

export const dbQueryDuration = new Histogram({
  name: 'stockos_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

export const dbConnectionsActive = new Gauge({
  name: 'stockos_db_connections_active',
  help: 'Number of active database connections',
  registers: [metricsRegistry],
});

// ============================================================================
// Utility Functions
// ============================================================================

export function recordMovement(
  movementType: string,
  quantity: number,
  warehouseId: string,
  tenantId: string
): void {
  movementsTotal.inc({ movement_type: movementType, warehouse_id: warehouseId, tenant_id: tenantId });
  movementQuantity.inc({ movement_type: movementType, warehouse_id: warehouseId, tenant_id: tenantId }, quantity);
}

export function recordCommand(
  commandType: string,
  status: 'success' | 'failure',
  duration: number,
  tenantId: string
): void {
  commandsProcessed.inc({ command_type: commandType, status, tenant_id: tenantId });
  commandProcessingDuration.observe({ command_type: commandType }, duration);
}

export function recordEvent(eventType: string, tenantId: string): void {
  eventsPublished.inc({ event_type: eventType, tenant_id: tenantId });
}

export function recordAgentExecution(
  agentName: string,
  status: 'success' | 'failure',
  duration: number
): void {
  agentExecutions.inc({ agent_name: agentName, status });
  agentExecutionDuration.observe({ agent_name: agentName }, duration);
}

export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

export function getContentType(): string {
  return metricsRegistry.contentType;
}
