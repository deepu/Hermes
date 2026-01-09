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
  event: string;
}

/**
 * Extended log entry with optional context fields
 */
export interface LogEntry extends BaseLogEntry {
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
  /** Model probability (0-1) */
  modelProbability?: number;
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
  /** Number of trackers */
  trackerCount?: number;
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
  /** Additional context (for extensibility) */
  [key: string]: unknown;
}

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
// StrategyLogger Implementation
// ============================================================================

/**
 * Structured JSON logger for strategy services
 *
 * Designed for Railway's log aggregation system.
 * All logs are emitted as single-line JSON objects to stdout.
 *
 * @example
 * const logger = new StrategyLogger({ strategy: 'Crypto15ML' });
 *
 * logger.info('signal_generated', {
 *   marketId: '0xabc123',
 *   symbol: 'BTCUSDT',
 *   side: 'YES',
 *   confidence: 0.73,
 * });
 *
 * // Outputs:
 * // {"timestamp":"2026-01-08T14:23:45.123Z","level":"INFO","strategy":"Crypto15ML",...}
 */
export class StrategyLogger {
  private readonly config: Required<StrategyLoggerConfig>;

  constructor(config: StrategyLoggerConfig) {
    this.config = {
      strategy: config.strategy,
      enabled: config.enabled ?? true,
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
  info(event: string, context?: Partial<LogEntry>): void {
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
  warn(event: string, context?: Partial<LogEntry>): void {
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
  error(event: string, context?: Partial<LogEntry>): void {
    this.log('ERROR', event, context);
  }

  /**
   * Check if logging is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable logging at runtime
   */
  setEnabled(enabled: boolean): void {
    (this.config as { enabled: boolean }).enabled = enabled;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Core logging method
   *
   * Creates a structured JSON log entry and emits to stdout.
   */
  private log(level: LogLevel, event: string, context?: Partial<LogEntry>): void {
    if (!this.config.enabled) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      strategy: this.config.strategy,
      event,
      // Railway metadata
      _service: this.config.service,
      _app: this.config.app,
      _env: this.config.environment,
      ...context,
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
): StrategyLogger {
  return new StrategyLogger({
    strategy: 'Crypto15ML',
    ...options,
  });
}

// ============================================================================
// Log Event Constants
// ============================================================================

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
  PREDICTIVE_SCAN: 'predictive_scan',
  REACTIVE_SCAN: 'reactive_scan',

  // Signals
  SIGNAL_GENERATED: 'signal_generated',
  SIGNAL_REJECTED: 'signal_rejected',

  // Executions
  EXECUTION_SUCCESS: 'execution_success',
  EXECUTION_FAILED: 'execution_failed',
  ORDER_PLACED: 'order_placed',

  // Paper Trading (Dry Run)
  PAPER_POSITION: 'paper_position',
  PAPER_SETTLEMENT: 'paper_settlement',

  // Errors
  WEBSOCKET_DISCONNECTED: 'websocket_disconnected',
  WEBSOCKET_RECONNECTED: 'websocket_reconnected',
  API_RATE_LIMIT: 'api_rate_limit',
  MODEL_INFERENCE_ERROR: 'model_inference_error',
  FEATURE_COMPUTATION_ERROR: 'feature_computation_error',
  PRICE_VALIDATION_ERROR: 'price_validation_error',

  // General
  ERROR: 'error',
  WARNING: 'warning',
} as const;

export type LogEventType = (typeof LogEvents)[keyof typeof LogEvents];
