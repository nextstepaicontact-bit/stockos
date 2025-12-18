import { trace, context, SpanStatusCode, Span, Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

export interface TracingConfig {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
}

export function initTracing(config: TracingConfig): void {
  if (!config.enabled && process.env.OTEL_ENABLED !== 'true') {
    console.log('Tracing disabled');
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: config.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion || '1.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: config.environment || process.env.NODE_ENV || 'development',
    }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.on('SIGTERM', () => {
    sdk?.shutdown()
      .then(() => console.log('Tracing terminated'))
      .catch((error) => console.error('Error terminating tracing', error))
      .finally(() => process.exit(0));
  });

  console.log(`Tracing initialized for ${config.serviceName}`);
}

export function getTracer(name: string = 'stockos'): Tracer {
  return trace.getTracer(name);
}

export interface SpanOptions {
  attributes?: Record<string, string | number | boolean>;
  tenantId?: string;
  correlationId?: string;
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {}
): Promise<T> {
  const tracer = getTracer();

  return tracer.startActiveSpan(name, async (span) => {
    try {
      // Add common attributes
      if (options.tenantId) {
        span.setAttribute('tenant.id', options.tenantId);
      }
      if (options.correlationId) {
        span.setAttribute('correlation.id', options.correlationId);
      }
      if (options.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
          span.setAttribute(key, value);
        }
      }

      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

export function createSpan(
  name: string,
  options: SpanOptions = {}
): Span {
  const tracer = getTracer();
  const span = tracer.startSpan(name);

  if (options.tenantId) {
    span.setAttribute('tenant.id', options.tenantId);
  }
  if (options.correlationId) {
    span.setAttribute('correlation.id', options.correlationId);
  }
  if (options.attributes) {
    for (const [key, value] of Object.entries(options.attributes)) {
      span.setAttribute(key, value);
    }
  }

  return span;
}

export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
  const span = getCurrentSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

export function setSpanAttribute(key: string, value: string | number | boolean): void {
  const span = getCurrentSpan();
  if (span) {
    span.setAttribute(key, value);
  }
}

export function setSpanError(error: Error): void {
  const span = getCurrentSpan();
  if (span) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException(error);
  }
}

// Decorator for tracing methods
export function Trace(spanName?: string) {
  return function (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const name = spanName || `${(target as object).constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      return withSpan(name, async () => {
        return originalMethod.apply(this, args);
      });
    };

    return descriptor;
  };
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}
