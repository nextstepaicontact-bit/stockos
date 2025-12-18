import pino, { Logger as PinoLogger, LoggerOptions } from 'pino';

export interface LogContext {
  tenantId?: string;
  warehouseId?: string;
  correlationId?: string;
  userId?: string;
  requestId?: string;
  [key: string]: unknown;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const isDevelopment = process.env.NODE_ENV === 'development';

const defaultOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname,
      service: process.env.SERVICE_NAME || 'stockos',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password',
      'secret',
      'token',
      'authorization',
      'cookie',
      '*.password',
      '*.secret',
      '*.token',
    ],
    remove: true,
  },
};

const devTransport = {
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'HH:MM:ss.l',
    ignore: 'pid,hostname',
    singleLine: false,
  },
};

export const rootLogger: PinoLogger = isDevelopment
  ? pino({ ...defaultOptions, transport: devTransport })
  : pino(defaultOptions);

export class Logger {
  private logger: PinoLogger;
  private context: LogContext;

  constructor(context: LogContext = {}, parentLogger?: PinoLogger) {
    this.context = context;
    this.logger = (parentLogger || rootLogger).child(context);
  }

  child(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context }, this.logger);
  }

  trace(msg: string, data?: Record<string, unknown>): void {
    this.logger.trace(data, msg);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.logger.debug(data, msg);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.logger.info(data, msg);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.logger.warn(data, msg);
  }

  error(msg: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    if (error instanceof Error) {
      this.logger.error(
        {
          ...data,
          err: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        },
        msg
      );
    } else {
      this.logger.error({ ...data, err: error }, msg);
    }
  }

  fatal(msg: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    if (error instanceof Error) {
      this.logger.fatal(
        {
          ...data,
          err: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        },
        msg
      );
    } else {
      this.logger.fatal({ ...data, err: error }, msg);
    }
  }

  // Structured logging for specific events
  logEvent(eventType: string, data: Record<string, unknown>): void {
    this.info(`Event: ${eventType}`, { event_type: eventType, ...data });
  }

  logCommand(commandType: string, data: Record<string, unknown>): void {
    this.info(`Command: ${commandType}`, { command_type: commandType, ...data });
  }

  logMetric(metricName: string, value: number, tags?: Record<string, string>): void {
    this.debug(`Metric: ${metricName}`, { metric: metricName, value, tags });
  }
}

// Default logger instance
export const logger = new Logger();

// Factory function for creating contextual loggers
export function createLogger(context: LogContext): Logger {
  return new Logger(context);
}

// Request-scoped logger middleware context
export function createRequestLogger(
  correlationId: string,
  tenantId?: string,
  userId?: string
): Logger {
  return new Logger({
    correlationId,
    tenantId,
    userId,
  });
}
