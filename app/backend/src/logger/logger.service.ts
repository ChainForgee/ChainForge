import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import pino, { Logger as PinoLogger, Bindings, ChildLoggerOptions } from 'pino';
import { AsyncLocalStorage } from 'async_hooks';
import { CORRELATION_ID_KEY } from '../common/utils/correlation-id.util';
import { redactLogData } from './log-redaction.util';

// Type definitions
type LogLevel = 'info' | 'error' | 'warn' | 'debug' | 'trace';
type LogMessage = string | Record<string, unknown>;
type LogMeta = Record<string, unknown> | undefined;
type LogContext = string | undefined;
type ErrorTrace = string | undefined;

// Interface for log entries
interface LogEntry {
  message?: string;
  context?: string;
  correlationId?: string;
  timestamp: string;
  [key: string]: unknown;
}

// Pino path patterns for built-in redaction.  Matches the same sensitive
// keys recognised by `log-redaction.util.ts`, applied with limited nesting
// so it remains cost-effective at log-construction time.
const SENSITIVE_REDACT_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'creditcard',
  'ssn',
];

const REDACT_MAX_DEPTH = 4;

const buildRedactPaths = (): string[] => {
  const paths: string[] = [];
  for (let depth = 1; depth <= REDACT_MAX_DEPTH; depth += 1) {
    const prefix =
      depth === 1
        ? ''
        : Array(depth - 1)
            .fill('*')
            .join('.') + '.';
    for (const key of SENSITIVE_REDACT_KEYS) {
      paths.push(`${prefix}${key}`);
    }
  }
  return paths;
};

const PINO_REDACT_PATHS = buildRedactPaths();

const isProduction = (): boolean =>
  (process.env.NODE_ENV ?? 'development').toLowerCase() === 'production';

const isTest = (): boolean =>
  (process.env.NODE_ENV ?? 'development').toLowerCase() === 'test' ||
  process.env.JEST_WORKER_ID !== undefined;

/**
 * Returns true when pino should output structured JSON without a transport.
 * In production, logs must be machine-parseable for ELK / Datadog / CloudWatch.
 * In test, pinned formatting keeps the test suite from hanging on worker threads
 * when pino-pretty spawns its own worker.
 */
const shouldUseJsonOutput = (): boolean => isProduction() || isTest();

@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly logger: PinoLogger;
  private readonly asyncLocalStorage = new AsyncLocalStorage<
    Map<string, unknown>
  >();

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: PINO_REDACT_PATHS,
        censor: '[REDACTED]',
      },
      formatters: {
        level: (label: string): Record<string, unknown> => ({ level: label }),
        log: (object: Record<string, unknown>): Record<string, unknown> => {
          const correlationId = this.getCorrelationId();
          if (correlationId) {
            return { ...object, correlationId };
          }
          return object;
        },
      },
      // Pretty-print only when running locally outside tests/production.
      ...(shouldUseJsonOutput()
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: {
                singleLine: true,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname',
                colorize: true,
              },
            },
          }),
    });
  }

  /**
   * Get correlation ID from async local storage
   */
  getCorrelationId(): string | undefined {
    const store = this.asyncLocalStorage.getStore();
    return store?.get(CORRELATION_ID_KEY) as string | undefined;
  }

  /**
   * Apply the recursive redaction utility to meta payload before Pino
   * serialisation.  Defense in depth alongside Pino's `redact` paths so
   * deeply nested sensitive data is scrubbed regardless of nesting depth.
   */
  private redactMeta(meta: LogMeta): LogMeta {
    if (!meta || typeof meta !== 'object') {
      return meta;
    }
    try {
      return redactLogData(meta);
    } catch {
      // Never let redaction failures break log emission.
      return meta;
    }
  }

  /**
   * Format message with correlation ID for methods that bypass Pino's formatters
   */
  private formatMessage(
    message: LogMessage,
    context?: string,
    meta?: LogMeta,
  ): LogEntry {
    const correlationId = this.getCorrelationId();
    const timestamp = new Date().toISOString();
    const safeMeta = this.redactMeta(meta);

    // If message is an object, merge it with metadata
    if (typeof message === 'object' && message !== null) {
      try {
        return {
          ...message,
          ...(safeMeta || {}),
          correlationId,
          context,
          timestamp,
        };
      } catch {
        return {
          message: '[unserialisable payload]',
          correlationId,
          context,
          timestamp,
        };
      }
    }

    // String message with metadata
    return {
      message,
      ...(safeMeta || {}),
      correlationId,
      context,
      timestamp,
    };
  }

  /**
   * Log a message with context
   */
  log(message: LogMessage, context?: LogContext, meta?: LogMeta): void {
    const correlationId = this.getCorrelationId();
    const safeMeta = this.redactMeta(meta);

    if (typeof message === 'object' && message !== null) {
      try {
        this.logger.info({
          context,
          correlationId,
          ...message,
          ...(safeMeta || {}),
        });
      } catch {
        this.logger.info(
          { context, correlationId },
          '[unserialisable payload]',
        );
      }
    } else {
      this.logger.info(
        { context, correlationId, ...(safeMeta || {}) },
        message,
      );
    }
  }

  /**
   * Log an error message
   */
  error(
    message: LogMessage,
    trace?: ErrorTrace,
    context?: LogContext,
    meta?: LogMeta,
  ): void {
    const correlationId = this.getCorrelationId();
    const safeMeta = this.redactMeta(meta);

    if (typeof message === 'object' && message !== null) {
      try {
        this.logger.error({
          context,
          correlationId,
          trace,
          ...message,
          ...(safeMeta || {}),
        });
      } catch {
        this.logger.error(
          { context, correlationId, trace },
          '[unserialisable payload]',
        );
      }
    } else {
      this.logger.error(
        { context, correlationId, trace, ...(safeMeta || {}) },
        message,
      );
    }
  }

  /**
   * Log a warning message
   */
  warn(message: LogMessage, context?: LogContext, meta?: LogMeta): void {
    const correlationId = this.getCorrelationId();
    const safeMeta = this.redactMeta(meta);

    if (typeof message === 'object' && message !== null) {
      try {
        this.logger.warn({
          context,
          correlationId,
          ...message,
          ...(safeMeta || {}),
        });
      } catch {
        this.logger.warn(
          { context, correlationId },
          '[unserialisable payload]',
        );
      }
    } else {
      this.logger.warn(
        { context, correlationId, ...(safeMeta || {}) },
        message,
      );
    }
  }

  /**
   * Log a debug message
   */
  debug(message: LogMessage, context?: LogContext, meta?: LogMeta): void {
    const correlationId = this.getCorrelationId();
    const safeMeta = this.redactMeta(meta);

    if (typeof message === 'object' && message !== null) {
      try {
        this.logger.debug({
          context,
          correlationId,
          ...message,
          ...(safeMeta || {}),
        });
      } catch {
        this.logger.debug(
          { context, correlationId },
          '[unserialisable payload]',
        );
      }
    } else {
      this.logger.debug(
        { context, correlationId, ...(safeMeta || {}) },
        message,
      );
    }
  }

  /**
   * Log a verbose message
   */
  verbose(message: LogMessage, context?: LogContext, meta?: LogMeta): void {
    const correlationId = this.getCorrelationId();
    const safeMeta = this.redactMeta(meta);

    if (typeof message === 'object' && message !== null) {
      try {
        this.logger.trace({
          context,
          correlationId,
          ...message,
          ...(safeMeta || {}),
        });
      } catch {
        this.logger.trace(
          { context, correlationId },
          '[unserialisable payload]',
        );
      }
    } else {
      this.logger.trace(
        { context, correlationId, ...(safeMeta || {}) },
        message,
      );
    }
  }

  /**
   * Get the underlying Pino logger instance
   */
  getLogger(): PinoLogger {
    return this.logger;
  }

  /**
   * Expose the async local storage for middleware use
   */
  getAsyncLocalStorage(): AsyncLocalStorage<Map<string, unknown>> {
    return this.asyncLocalStorage;
  }

  /**
   * Create a child logger with fixed correlation ID
   */
  child(bindings: Bindings, options?: ChildLoggerOptions): LoggerService {
    const childLogger = this.logger.child(bindings, options);
    const correlationId = this.getCorrelationId();

    // Create a proxy that maintains correlation ID in methods
    const proxy = new Proxy(this, {
      get: (target: LoggerService, prop: string | symbol): unknown => {
        if (prop === 'getLogger') {
          return (): PinoLogger => childLogger;
        }

        const logMethods = ['log', 'error', 'warn', 'debug', 'verbose'];
        if (typeof prop === 'string' && logMethods.includes(prop)) {
          return (...args: unknown[]): void => {
            const pinoMethod =
              prop === 'verbose' ? 'trace' : (prop as LogLevel);
            const lastArg = args[args.length - 1];

            if (
              lastArg &&
              typeof lastArg === 'object' &&
              !Array.isArray(lastArg)
            ) {
              // Meta object provided
              const meta = {
                ...this.redactMeta(lastArg as LogMeta),
                correlationId,
              };
              args[args.length - 1] = meta;
            } else {
              // No meta object, add one
              args.push({ correlationId });
            }

            // Type assertion needed for dynamic method call
            (
              childLogger as unknown as Record<
                string,
                (...args: unknown[]) => void
              >
            )[pinoMethod](...args);
          };
        }

        return target[prop as keyof LoggerService];
      },
    });

    return proxy;
  }
}
