/**
 * Trade Persistence Type Definitions
 *
 * TypeScript interfaces for the Crypto15ML trade persistence layer.
 * Used for recording paper trades, outcomes, and analysis data.
 *
 * Part of #25
 */

import type { CryptoAsset, FeatureVector } from '../strategies/crypto15-feature-engine.js';

// ============================================================================
// Validation Constants (for runtime type checking)
// ============================================================================

/** Valid crypto assets for runtime validation */
export const VALID_CRYPTO_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;

/** Valid trade sides for runtime validation */
export const VALID_TRADE_SIDES = ['YES', 'NO'] as const;

/** Valid volatility regimes for runtime validation */
export const VALID_VOLATILITY_REGIMES = ['low', 'mid', 'high'] as const;

/** Valid trade outcomes for runtime validation */
export const VALID_TRADE_OUTCOMES = ['UP', 'DOWN'] as const;

// ============================================================================
// Core Trade Record Types
// ============================================================================

/**
 * Volatility regime classification
 */
export type VolatilityRegime = (typeof VALID_VOLATILITY_REGIMES)[number];

/**
 * Trade outcome direction
 */
export type TradeOutcomeDirection = (typeof VALID_TRADE_OUTCOMES)[number];

/**
 * Trade side
 */
export type TradeSide = (typeof VALID_TRADE_SIDES)[number];

/**
 * Complete trade record with all tiers of data
 */
export interface TradeRecord {
  // === Identity ===
  /** Database ID (auto-assigned on insert) */
  id?: number;
  /** Polymarket condition ID */
  conditionId: string;
  /** Market slug */
  slug: string;
  /** Crypto asset: BTC, ETH, SOL, XRP */
  symbol: CryptoAsset;

  // === Trade Details ===
  /** Position side: YES or NO */
  side: TradeSide;
  /** Entry price (0-1 range) */
  entryPrice: number;
  /** Position size in USD */
  positionSize: number;
  /** Unix ms when signal was generated */
  signalTimestamp: number;

  // === Model Output ===
  /** Model probability prediction (0-1) */
  probability: number;
  /** Z-score before sigmoid (linear combination) */
  linearCombination: number;
  /** Number of features that were imputed */
  imputedCount: number;
  /** Full feature vector at trade time */
  features: FeatureVector;

  // === Outcome (filled on resolution) ===
  /** Market outcome: UP or DOWN */
  outcome?: TradeOutcomeDirection;
  /** Whether the trade was a win */
  isWin?: boolean;
  /** Realized P&L in USD */
  pnl?: number;
  /** Unix ms when market resolved */
  resolutionTimestamp?: number;

  // === Regime Analysis (Tier 2) ===
  /** Minute within window (0-14) */
  stateMinute: number;
  /** Hour of day (0-23 UTC) */
  hourOfDay: number;
  /** Day of week (0=Sunday, 6=Saturday) */
  dayOfWeek: number;
  /** Volatility regime classification */
  volatilityRegime?: VolatilityRegime;
  /** Raw 5-minute volatility value */
  volatility5m?: number;

  // === Timing Analysis ===
  /** Minutes to hit up threshold (undefined if never hit) */
  timeToUpThreshold?: number;
  /** Minutes to hit down threshold (undefined if never hit) */
  timeToDownThreshold?: number;

  // === Excursion Analysis ===
  /** Best price move in trade's favor */
  maxFavorableExcursion?: number;
  /** Worst price move against trade */
  maxAdverseExcursion?: number;

  // === Price Context (Tier 3) ===
  /** Price at window start */
  windowOpenPrice?: number;
  /** Price at window end */
  windowClosePrice?: number;
  /** Bid price at entry (if available) */
  entryBidPrice?: number;
  /** Ask price at entry (if available) */
  entryAskPrice?: number;

  // === Minute Prices ===
  /** Minute-level price snapshots during window */
  minutePrices?: MinutePrice[];

  // === Metadata ===
  /** Record creation timestamp */
  createdAt?: number;
  /** Last update timestamp */
  updatedAt?: number;
}

/**
 * Minute-level price snapshot during trade window
 */
export interface MinutePrice {
  /** Minute offset within window (0-14) */
  minuteOffset: number;
  /** Unix ms timestamp */
  timestamp: number;
  /** Spot price at this minute */
  price: number;
}

/**
 * Trade outcome data for updating resolved trades
 */
export interface TradeOutcome {
  /** Market outcome direction */
  outcome: TradeOutcomeDirection;
  /** Whether the trade was a win */
  isWin: boolean;
  /** Realized P&L in USD */
  pnl: number;
  /** Unix ms when resolved */
  resolutionTimestamp: number;
  /** Price at window close */
  windowClosePrice: number;
  /** Minutes to hit up threshold */
  timeToUpThreshold?: number;
  /** Minutes to hit down threshold */
  timeToDownThreshold?: number;
  /** Maximum favorable excursion */
  maxFavorableExcursion: number;
  /** Maximum adverse excursion */
  maxAdverseExcursion: number;
}

// ============================================================================
// Analysis Types
// ============================================================================

/**
 * Statistics for a volatility regime
 */
export interface RegimeStats {
  /** Regime classification */
  regime: VolatilityRegime;
  /** Total number of trades */
  totalTrades: number;
  /** Number of winning trades */
  wins: number;
  /** Win rate percentage */
  winRate: number;
  /** Average P&L per trade */
  avgPnl: number;
  /** Total P&L */
  totalPnl: number;
}

/**
 * Calibration bucket for predicted vs actual win rates
 */
export interface CalibrationBucket {
  /** Probability bucket label (e.g., "0.70-0.75") */
  bucket: string;
  /** Lower bound of probability range */
  lowerBound: number;
  /** Upper bound of probability range */
  upperBound: number;
  /** Number of trades in bucket */
  trades: number;
  /** Average predicted probability */
  avgPredicted: number;
  /** Actual win rate in bucket */
  actualWinRate: number;
  /** Calibration gap (actual - predicted) */
  calibrationGap: number;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  /** Total number of trades */
  totalTrades: number;
  /** Number of pending (unresolved) trades */
  pendingTrades: number;
  /** Number of resolved trades */
  resolvedTrades: number;
  /** Database file size in bytes */
  dbSizeBytes: number;
  /** Timestamp of oldest trade */
  oldestTrade?: number;
  /** Timestamp of newest trade */
  newestTrade?: number;
}

// ============================================================================
// Repository Interface
// ============================================================================

/**
 * Trade repository interface for persistence operations
 */
export interface ITradeRepository {
  // === Lifecycle ===
  /** Initialize the database and run migrations */
  initialize(): Promise<void>;
  /** Close the database connection */
  close(): Promise<void>;

  // === Write Operations ===
  /** Record a new trade, returns the database ID */
  recordTrade(trade: TradeRecord): Promise<number>;
  /** Update trade outcome on resolution */
  updateOutcome(conditionId: string, outcome: TradeOutcome): Promise<void>;
  /** Record a minute price snapshot */
  recordMinutePrice(tradeId: number, minute: number, price: number, timestamp: number): Promise<void>;

  // === Read Operations ===
  /** Get trade by Polymarket condition ID */
  getTradeByConditionId(conditionId: string): Promise<TradeRecord | null>;
  /** Get all trades awaiting resolution (with optional limit, default 1000) */
  getPendingTrades(limit?: number): Promise<TradeRecord[]>;
  /** Get trade by database ID */
  getTradeById(id: number): Promise<TradeRecord | null>;

  // === Analysis Queries ===
  /** Get trades within a date range */
  getTradesByDateRange(start: Date, end: Date): Promise<TradeRecord[]>;
  /** Get trades for a specific symbol */
  getTradesBySymbol(symbol: CryptoAsset): Promise<TradeRecord[]>;
  /** Get performance statistics by volatility regime */
  getPerformanceByRegime(regime: VolatilityRegime): Promise<RegimeStats>;
  /** Get calibration data for all probability buckets */
  getCalibrationData(): Promise<CalibrationBucket[]>;

  // === Maintenance ===
  /** Run VACUUM to reclaim space */
  vacuum(): Promise<void>;
  /** Get database statistics */
  getStats(): Promise<DatabaseStats>;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Persistence configuration options
 */
export interface PersistenceConfig {
  /** Enable persistence (default: true) */
  enabled: boolean;
  /** Database file path (default: './data/crypto15ml/trades.db') */
  dbPath: string;
  /** Write mode: 'async' for non-blocking, 'sync' for immediate (default: 'async') */
  syncMode: 'async' | 'sync';
  /** Hours between automatic VACUUM operations (default: 24) */
  vacuumIntervalHours: number;
}

/**
 * Default persistence configuration (immutable)
 */
export const DEFAULT_PERSISTENCE_CONFIG = {
  enabled: true,
  dbPath: './data/crypto15ml/trades.db',
  syncMode: 'async',
  vacuumIntervalHours: 24,
} as const satisfies PersistenceConfig;
