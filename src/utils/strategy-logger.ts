/**
 * Strategy Logger
 *
 * Railway-compatible structured JSON logging for strategy services.
 * Emits JSON logs for monitoring, filtering, and searchability in Railway's dashboard.
 *
 * Key features:
 * - Structured JSON format (one JSON object per line)
 * - Consistent context fields: timestamp, level, strategy, event
 * - Railway-searchable: filter by symbol, event type, level
 * - No PII or sensitive data (API keys, private keys)
 * - Minimal performance impact
 *
 * Part of #9
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Log levels supported by the logger
 */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * Standard event names for consistent filtering
 */
export const LogEvents = {
  // Strategy Lifecycle
  STRATEGY_STARTED: 'strategy_started',
  STRATEGY_STOPPED: 'strategy_stopped',
  MODELS_LOADED: 'models_loaded',
  PRICE_SUBSCRIPTION_ACTIVE: 'price_subscription_active',

  // Market Discovery
  MARKET_ADDED: 'market_added',
  MARKET_REMOVED: 'market_removed',
  TRACKERS_CLEANED: 'trackers_cleaned',

  // Signals
  SIGNAL_GENERATED: 'signal_generated',
  SIGNAL_REJECTED: 'signal_rejected',

  // Executions
  EXECUTION_SUCCESS: 'execution_success',
  EXECUTION_FAILED: 'execution_failed',

  // Paper Trading (Dry Run)
  PAPER_POSITION: 'paper_position',
  PAPER_POSITION_EVICTED: 'paper_position_evicted',
  PAPER_SETTLEMENT: 'paper_settlement',

  // Persistence
  REPOSITORY_INITIALIZED: 'repository_initialized',
  TRADE_PERSISTED: 'trade_persisted',
  OUTCOME_PERSISTED: 'outcome_persisted',
  PERSISTENCE_ERROR: 'persistence_error',

  // General
  ERROR: 'error',
} as const;

export type LogEventType = (typeof LogEvents)[keyof typeof LogEvents];

/**
 * Base log entry with required fields
 */
export interface BaseLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Strategy name (e.g., 'Crypto15ML') */
  strategy: string;
  /** Event type for filtering (e.g., 'signal_generated', 'execution_success') */
  event: LogEventType;
  /** Railway service name */
  _service: string;
  /** Railway app name */
  _app: string;
  /** Railway environment */
  _env: string;
}

/**
 * Context fields for log entries (excludes base fields)
 */
export interface LogContext {
  /** Market condition ID */
  marketId?: string;
  /** Binance symbol (e.g., 'BTCUSDT') */
  symbol?: string;
  /** Market slug (e.g., 'btc-updown-15m-1767456000') */
  slug?: string;
  /** State minute (0-14) */
  stateMinute?: number;
  /** Signal direction */
  side?: 'YES' | 'NO';
  /** Model confidence (0-1) */
  confidence?: number;
  /** Entry price (0-1) */
  entryPrice?: number;
  /** Number of imputed features */
  imputedFeatures?: number;
  /** Order ID */
  orderId?: string;
  /** Error message */
  error?: string;
  /** Error code (for categorization) */
  errorCode?: string;
  /** Human-readable message */
  message?: string;
  /** Number of models loaded */
  modelCount?: number;
  /** Number of trackers */
  trackerCount?: number;
  /** Number of positions */
  positionCount?: number;
  /** Number of items removed (for cleanup events) */
  removedCount?: number;
  /** Number of items remaining (for cleanup events) */
  remainingCount?: number;
  /** Was trade successful */
  success?: boolean;
  /** P&L value */
  pnl?: number;
  /** Position size */
  size?: number;
  /** Dry run mode indicator */
  dryRun?: boolean;
  /** Linear combination (z-score) */
  linearCombination?: number;
  /** Database trade ID */
  tradeId?: number;
  /** Database path */
  dbPath?: string;
  /** Trade outcome direction */
  outcome?: 'UP' | 'DOWN';
  /** Whether trade was a win */
  isWin?: boolean;
}

/**
 * Full log entry combining base fields and context
 */
export interface LogEntry extends BaseLogEntry, LogContext {}

/**
 * Configuration for StrategyLogger
 */
export interface StrategyLoggerConfig {
  /** Strategy name to include in all logs */
  strategy: string;
  /** Whether to enable logging (default: true) */
  enabled?: boolean;
  /** Service name for Railway (default: 'hermes') */
  service?: string;
  /** Application name for Railway (default: 'trading') */
  app?: string;
  /** Environment (e.g., 'production', 'staging', 'development') */
  environment?: string;
}

// ============================================================================
// IStrategyLogger Interface
// ============================================================================

/**
 * Interface for strategy loggers
 *
 * Enables dependency injection and testability.
 */
export interface IStrategyLogger {
  /** Log an INFO level message */
  info(event: LogEventType, context?: LogContext): void;
  /** Log a WARN level message */
  warn(event: LogEventType, context?: LogContext): void;
  /** Log an ERROR level message */
  error(event: LogEventType, context?: LogContext): void;
  /** Check if logging is enabled */
  isEnabled(): boolean;
}

// ============================================================================
// StrategyLogger Implementation
// ============================================================================

/** Maximum error message length to prevent log bloat */
const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * Structured JSON logger for strategy services
 *
 * Designed for Railway's log aggregation system.
 * All logs are emitted as single-line JSON objects to stdout.
 *
 * @example
 * const logger = new StrategyLogger({ strategy: 'Crypto15ML' });
 *
 * logger.info(LogEvents.SIGNAL_GENERATED, {
 *   marketId: '0xabc123',
 *   symbol: 'BTCUSDT',
 *   side: 'YES',
 *   confidence: 0.73,
 * });
 *
 * // Outputs:
 * // {"timestamp":"2026-01-08T14:23:45.123Z","level":"INFO","strategy":"Crypto15ML",...}
 */
export class StrategyLogger implements IStrategyLogger {
  private readonly config: {
    readonly strategy: string;
    readonly service: string;
    readonly app: string;
    readonly environment: string;
  };
  private readonly enabled: boolean;

  constructor(config: StrategyLoggerConfig) {
    this.enabled = config.enabled ?? true;
    this.config = {
      strategy: config.strategy,
      service: config.service ?? 'hermes',
      app: config.app ?? 'trading',
      environment: config.environment ?? process.env.NODE_ENV ?? 'development',
    };
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Log an INFO level message
   *
   * Use for normal operational events:
   * - Strategy started/stopped
   * - Signal generated
   * - Order executed successfully
   * - Market added/removed
   */
  info(event: LogEventType, context?: LogContext): void {
    this.log('INFO', event, context);
  }

  /**
   * Log a WARN level message
   *
   * Use for non-critical issues:
   * - Signal rejected (price too high, wrong state minute)
   * - Order partially filled
   * - Transient errors that will be retried
   */
  warn(event: LogEventType, context?: LogContext): void {
    this.log('WARN', event, context);
  }

  /**
   * Log an ERROR level message
   *
   * Use for critical issues:
   * - WebSocket disconnection
   * - API rate limit exceeded
   * - Model inference error
   * - Order execution failure
   */
  error(event: LogEventType, context?: LogContext): void {
    this.log('ERROR', event, context);
  }

  /**
   * Check if logging is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Sanitize error message to prevent log bloat and sensitive data leakage
   */
  static sanitizeErrorMessage(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.length > MAX_ERROR_MESSAGE_LENGTH) {
      return msg.substring(0, MAX_ERROR_MESSAGE_LENGTH) + '...';
    }
    return msg;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Core logging method
   *
   * Creates a structured JSON log entry and emits to stdout.
   * Base fields are applied after context to prevent override attacks.
   */
  private log(level: LogLevel, event: LogEventType, context?: LogContext): void {
    if (!this.enabled) {
      return;
    }

    // Spread context first, then base fields to prevent context from overriding
    // critical log metadata (timestamp, level, event, strategy, etc.)
    const entry: LogEntry = {
      ...context,
      timestamp: new Date().toISOString(),
      level,
      strategy: this.config.strategy,
      event,
      _service: this.config.service,
      _app: this.config.app,
      _env: this.config.environment,
    };

    // Emit as single-line JSON for Railway parsing
    console.log(JSON.stringify(entry));
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a logger for Crypto15ML strategy
 */
export function createCrypto15MLLogger(
  options?: Partial<Omit<StrategyLoggerConfig, 'strategy'>>
): IStrategyLogger {
  return new StrategyLogger({
    strategy: 'Crypto15ML',
    ...options,
  });
}
