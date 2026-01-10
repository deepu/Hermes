/**
 * Shared Test Fixtures for Trade Persistence Tests
 *
 * Provides reusable factory functions for creating test data.
 * Used by both unit tests and integration tests.
 *
 * Part of #29
 */

import type { TradeRecord, TradeOutcome } from '../types/trade-record.types.js';
import type { FeatureVector, CryptoAsset } from '../strategies/crypto15-feature-engine.js';

/**
 * Create a test FeatureVector with sensible defaults
 */
export function createTestFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    stateMinute: 5,
    minutesRemaining: 10,
    hourOfDay: 14,
    dayOfWeek: 3,
    returnSinceOpen: 0.0005,
    maxRunUp: 0.0008,
    maxRunDown: -0.0003,
    return1m: 0.0002,
    return3m: 0.0004,
    return5m: 0.0006,
    volatility5m: 0.0012,
    hasUpHit: false,
    hasDownHit: false,
    firstUpHitMinute: NaN,
    firstDownHitMinute: NaN,
    asset: 'BTC' as CryptoAsset,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a test TradeRecord with sensible defaults
 */
export function createTestTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    conditionId: `test-cond-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    slug: 'btc-updown-15m-test',
    symbol: 'BTC' as CryptoAsset,
    side: 'YES',
    entryPrice: 0.65,
    positionSize: 100,
    signalTimestamp: Date.now(),
    probability: 0.72,
    linearCombination: 0.94,
    imputedCount: 0,
    features: createTestFeatures(),
    stateMinute: 5,
    hourOfDay: 14,
    dayOfWeek: 3,
    volatilityRegime: 'mid',
    volatility5m: 0.0012,
    windowOpenPrice: 50000,
    ...overrides,
  };
}

/**
 * Create a test TradeOutcome with sensible defaults
 */
export function createTestOutcome(overrides: Partial<TradeOutcome> = {}): TradeOutcome {
  return {
    outcome: 'UP',
    isWin: true,
    pnl: 53.85,
    resolutionTimestamp: Date.now(),
    windowClosePrice: 50100,
    maxFavorableExcursion: 0.003,
    maxAdverseExcursion: -0.001,
    ...overrides,
  };
}
