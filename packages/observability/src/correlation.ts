import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  correlationId: string;
  causationId?: string;
  tenantId?: string;
  warehouseId?: string;
  userId?: string;
  requestId?: string;
  startTime: number;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function createContext(
  options: Partial<Omit<RequestContext, 'correlationId' | 'startTime'>> & {
    correlationId?: string;
  } = {}
): RequestContext {
  return {
    correlationId: options.correlationId || randomUUID(),
    causationId: options.causationId,
    tenantId: options.tenantId,
    warehouseId: options.warehouseId,
    userId: options.userId,
    requestId: options.requestId || randomUUID(),
    startTime: Date.now(),
  };
}

export function runWithContext<T>(
  context: RequestContext,
  fn: () => T
): T {
  return asyncLocalStorage.run(context, fn);
}

export async function runWithContextAsync<T>(
  context: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

export function getCorrelationId(): string {
  const ctx = getContext();
  return ctx?.correlationId || randomUUID();
}

export function getTenantId(): string | undefined {
  return getContext()?.tenantId;
}

export function getWarehouseId(): string | undefined {
  return getContext()?.warehouseId;
}

export function getUserId(): string | undefined {
  return getContext()?.userId;
}

export function getElapsedTime(): number {
  const ctx = getContext();
  if (!ctx) return 0;
  return Date.now() - ctx.startTime;
}

export function withTenant<T>(tenantId: string, fn: () => T): T {
  const currentContext = getContext();
  const newContext: RequestContext = currentContext
    ? { ...currentContext, tenantId }
    : createContext({ tenantId });

  return runWithContext(newContext, fn);
}

export function withWarehouse<T>(warehouseId: string, fn: () => T): T {
  const currentContext = getContext();
  const newContext: RequestContext = currentContext
    ? { ...currentContext, warehouseId }
    : createContext({ warehouseId });

  return runWithContext(newContext, fn);
}

// HTTP headers for correlation propagation
export const CORRELATION_HEADERS = {
  CORRELATION_ID: 'x-correlation-id',
  CAUSATION_ID: 'x-causation-id',
  TENANT_ID: 'x-tenant-id',
  WAREHOUSE_ID: 'x-warehouse-id',
  REQUEST_ID: 'x-request-id',
} as const;

export function extractContextFromHeaders(
  headers: Record<string, string | string[] | undefined>
): Partial<RequestContext> {
  const getValue = (key: string): string | undefined => {
    const value = headers[key];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    correlationId: getValue(CORRELATION_HEADERS.CORRELATION_ID),
    causationId: getValue(CORRELATION_HEADERS.CAUSATION_ID),
    tenantId: getValue(CORRELATION_HEADERS.TENANT_ID),
    warehouseId: getValue(CORRELATION_HEADERS.WAREHOUSE_ID),
    requestId: getValue(CORRELATION_HEADERS.REQUEST_ID),
  };
}

export function createHeadersFromContext(
  context: RequestContext
): Record<string, string> {
  const headers: Record<string, string> = {
    [CORRELATION_HEADERS.CORRELATION_ID]: context.correlationId,
  };

  if (context.causationId) {
    headers[CORRELATION_HEADERS.CAUSATION_ID] = context.causationId;
  }
  if (context.tenantId) {
    headers[CORRELATION_HEADERS.TENANT_ID] = context.tenantId;
  }
  if (context.warehouseId) {
    headers[CORRELATION_HEADERS.WAREHOUSE_ID] = context.warehouseId;
  }
  if (context.requestId) {
    headers[CORRELATION_HEADERS.REQUEST_ID] = context.requestId;
  }

  return headers;
}
