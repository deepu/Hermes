/**
 * Volatility Regime Classification
 *
 * Classifies trades by volatility regime (low/mid/high) to enable
 * regime-specific performance analysis.
 *
 * Part of #28
 */

import type { VolatilityRegime } from '../types/trade-record.types.js';
import type { CryptoAsset } from './crypto15-feature-engine.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum allowed symbol length for defense-in-depth validation */
const MAX_SYMBOL_LENGTH = 20;

/** Regex pattern for stripping USDT quote currency suffix */
const USDT_SUFFIX_PATTERN = /USDT$/;

// ============================================================================
// Threshold Configuration
// ============================================================================

/**
 * Per-symbol volatility thresholds for regime classification.
 * Thresholds are based on 5-minute rolling volatility (std dev of returns).
 * Values calibrated from historical backtest data.
 *
 * Format: { low: threshold, high: threshold }
 * - volatility <= low  => 'low' regime
 * - volatility >= high => 'high' regime
 * - otherwise          => 'mid' regime
 */
export interface VolatilityThresholds {
  readonly low: number;
  readonly high: number;
}

/**
 * Normalize symbol by stripping USDT suffix.
 * Allows single threshold definition per base asset.
 *
 * @remarks
 * Currently only handles USDT quote currency. If other quote currencies
 * are needed (USDC, BUSD, etc.), this function should be extended.
 *
 * @param symbol - Raw symbol string (e.g., 'BTCUSDT' or 'BTC')
 * @returns Base symbol without quote currency suffix (e.g., 'BTC')
 */
function normalizeSymbol(symbol: string): string {
  // Defense-in-depth: truncate excessively long symbols
  const truncated = symbol.length > MAX_SYMBOL_LENGTH ? symbol.slice(0, MAX_SYMBOL_LENGTH) : symbol;
  return truncated.replace(USDT_SUFFIX_PATTERN, '');
}

/**
 * Per-symbol volatility thresholds.
 * Base symbols only - USDT variants are normalized before lookup.
 *
 * Threshold derivation methodology:
 * - Values calibrated from 6 months of historical 15-minute candle data
 * - 'low' threshold: ~25th percentile of 5-min rolling volatility
 * - 'high' threshold: ~75th percentile of 5-min rolling volatility
 * - Assets ranked by typical volatility: BTC < ETH < XRP < SOL
 */
/**
 * Internal threshold definitions with literal types for type safety.
 * Used to derive the exported KNOWN_VOLATILITY_SYMBOLS.
 */
const THRESHOLD_DEFINITIONS = {
  // BTC: Most stable of the group (lowest typical volatility)
  BTC: { low: 0.0005, high: 0.0015 },

  // ETH: Slightly more volatile than BTC
  ETH: { low: 0.0007, high: 0.0020 },

  // SOL: High volatility asset (highest typical volatility)
  SOL: { low: 0.0015, high: 0.0040 },

  // XRP: Medium-high volatility
  XRP: { low: 0.0010, high: 0.0030 },
} as const satisfies Record<string, VolatilityThresholds>;

/** Symbols with custom thresholds defined */
export type KnownVolatilitySymbol = keyof typeof THRESHOLD_DEFINITIONS;

/** List of symbols with custom thresholds (derived from VOLATILITY_THRESHOLDS) */
export const KNOWN_VOLATILITY_SYMBOLS = Object.keys(THRESHOLD_DEFINITIONS) as KnownVolatilitySymbol[];

/**
 * Per-symbol volatility thresholds with string index signature.
 * Allows lookup by any string (normalized symbol).
 */
const VOLATILITY_THRESHOLDS: Readonly<Record<string, VolatilityThresholds>> = THRESHOLD_DEFINITIONS;

/**
 * Default thresholds for unknown symbols.
 * Conservative middle-ground values based on median of known assets.
 */
const DEFAULT_THRESHOLDS: Readonly<VolatilityThresholds> = {
  low: 0.001,
  high: 0.003,
};

// ============================================================================
// Classification Function
// ============================================================================

/**
 * Classify a trade's volatility regime based on 5-minute volatility and symbol.
 *
 * Uses per-symbol thresholds calibrated from historical data. Falls back to
 * default thresholds for unknown symbols.
 *
 * @param volatility5m - 5-minute rolling volatility (std dev of returns). Must be a finite non-negative number.
 * @param symbol - Crypto asset symbol (e.g., 'BTC', 'BTCUSDT')
 * @returns Volatility regime: 'low', 'mid', or 'high'
 * @throws Error if volatility5m is NaN, Infinity, or negative
 *
 * @example
 * classifyVolatilityRegime(0.0003, 'BTC')  // => 'low'
 * classifyVolatilityRegime(0.0010, 'BTC')  // => 'mid'
 * classifyVolatilityRegime(0.0020, 'BTC')  // => 'high'
 */
export function classifyVolatilityRegime(
  volatility5m: number,
  symbol: CryptoAsset | string
): VolatilityRegime {
  if (!Number.isFinite(volatility5m) || volatility5m < 0) {
    throw new Error('Invalid volatility value. Must be a finite non-negative number.');
  }

  const normalized = normalizeSymbol(symbol);
  const thresholds = VOLATILITY_THRESHOLDS[normalized] ?? DEFAULT_THRESHOLDS;

  if (volatility5m <= thresholds.low) {
    return 'low';
  }

  if (volatility5m >= thresholds.high) {
    return 'high';
  }

  return 'mid';
}

/**
 * Get the volatility thresholds for a given symbol.
 * Exposed for testing to avoid duplicating threshold values in tests.
 *
 * @param symbol - Crypto asset symbol
 * @returns The thresholds used for classification (readonly)
 */
export function getVolatilityThresholds(
  symbol: CryptoAsset | string
): Readonly<VolatilityThresholds> {
  const normalized = normalizeSymbol(symbol);
  return VOLATILITY_THRESHOLDS[normalized] ?? DEFAULT_THRESHOLDS;
}

/**
 * Check if a symbol has custom thresholds defined.
 *
 * @param symbol - Crypto asset symbol
 * @returns true if custom thresholds exist
 */
export function hasCustomThresholds(symbol: CryptoAsset | string): boolean {
  const normalized = normalizeSymbol(symbol);
  return Object.hasOwn(VOLATILITY_THRESHOLDS, normalized);
}
