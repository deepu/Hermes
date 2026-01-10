/**
 * Volatility Regime Classification
 *
 * Classifies trades by volatility regime (low/mid/high) to enable
 * regime-specific performance analysis.
 *
 * Part of #28
 */

import type { VolatilityRegime } from '../types/trade-record.types.js';
import type { CryptoAsset } from '../strategies/crypto15-feature-engine.js';

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
interface VolatilityThresholds {
  readonly low: number;
  readonly high: number;
}

/**
 * Per-symbol volatility thresholds.
 * Uses BTCUSDT-style symbols as keys for flexibility.
 */
const VOLATILITY_THRESHOLDS: Readonly<Record<string, VolatilityThresholds>> = {
  // BTC: Most stable of the group
  BTC: { low: 0.0005, high: 0.0015 },
  BTCUSDT: { low: 0.0005, high: 0.0015 },

  // ETH: Slightly more volatile than BTC
  ETH: { low: 0.0007, high: 0.0020 },
  ETHUSDT: { low: 0.0007, high: 0.0020 },

  // SOL: High volatility asset
  SOL: { low: 0.0015, high: 0.0040 },
  SOLUSDT: { low: 0.0015, high: 0.0040 },

  // XRP: Medium-high volatility
  XRP: { low: 0.0010, high: 0.0030 },
  XRPUSDT: { low: 0.0010, high: 0.0030 },
};

/**
 * Default thresholds for unknown symbols.
 * Conservative middle-ground values.
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
 * @param volatility5m - 5-minute rolling volatility (std dev of returns)
 * @param symbol - Crypto asset symbol (e.g., 'BTC', 'BTCUSDT')
 * @returns Volatility regime: 'low', 'mid', or 'high'
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
  const thresholds = VOLATILITY_THRESHOLDS[symbol] ?? DEFAULT_THRESHOLDS;

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
 * Useful for debugging and testing.
 *
 * @param symbol - Crypto asset symbol
 * @returns The thresholds used for classification
 */
export function getVolatilityThresholds(
  symbol: CryptoAsset | string
): VolatilityThresholds {
  return VOLATILITY_THRESHOLDS[symbol] ?? DEFAULT_THRESHOLDS;
}

/**
 * Check if a symbol has custom thresholds defined.
 *
 * @param symbol - Crypto asset symbol
 * @returns true if custom thresholds exist
 */
export function hasCustomThresholds(symbol: CryptoAsset | string): boolean {
  return symbol in VOLATILITY_THRESHOLDS;
}
