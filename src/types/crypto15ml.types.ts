/**
 * Crypto15ML Public Type Definitions
 *
 * This module re-exports all public types and interfaces for the
 * Crypto15ML strategy. Import from this module for type-safe usage.
 *
 * @example
 * ```typescript
 * import type {
 *   Crypto15MLConfig,
 *   Signal,
 *   FeatureVector,
 *   PaperPosition,
 * } from '@catalyst-team/poly-sdk/types/crypto15ml';
 * ```
 *
 * Part of #10
 */

// Re-export configuration types
export type {
  Crypto15MLConfig,
  Signal,
  ExecutionResult,
  PaperPosition,
  PaperSettlement,
  PaperTradingStats,
  TrackerInfo,
  MarketAddedEvent,
  MarketRemovedEvent,
  Crypto15MLStrategyEvents,
} from '../services/crypto15-ml-strategy-service.js';

// Re-export feature engine types
export type {
  CryptoAsset,
  FeatureVector,
  FeatureMap,
} from '../strategies/crypto15-feature-engine.js';

// Re-export threshold constants
export { ASSET_THRESHOLDS } from '../strategies/crypto15-feature-engine.js';

// Re-export model types
export type {
  ModelConfig,
  PredictionResult,
} from '../strategies/crypto15-lr-model.js';

// Re-export logger types for consumers who want custom logging
export type {
  LogLevel,
  LogEventType,
  LogContext,
  IStrategyLogger,
} from '../utils/strategy-logger.js';

export { LogEvents } from '../utils/strategy-logger.js';

// Re-export persistence types for Crypto15ML consumers
export type {
  TradeRecord,
  TradeOutcome,
  MinutePrice,
  ITradeRepository,
  RegimeStats,
  CalibrationBucket,
  DatabaseStats,
  VolatilityRegime,
  TradeOutcomeDirection,
  TradeSide,
  PersistenceConfig,
} from './trade-record.types.js';
export {
  DEFAULT_PERSISTENCE_CONFIG,
  VALID_CRYPTO_ASSETS,
  VALID_TRADE_SIDES,
  VALID_VOLATILITY_REGIMES,
  VALID_TRADE_OUTCOMES,
} from './trade-record.types.js';
