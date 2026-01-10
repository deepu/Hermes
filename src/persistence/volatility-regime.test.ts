/**
 * Volatility Regime Classification Unit Tests
 *
 * Tests for the volatility regime classification function.
 *
 * Part of #28
 */

import { describe, it, expect } from 'vitest';
import {
  classifyVolatilityRegime,
  getVolatilityThresholds,
  hasCustomThresholds,
} from './volatility-regime.js';
import type { CryptoAsset } from '../strategies/crypto15-feature-engine.js';

// ============================================================================
// Test Data
// ============================================================================

const KNOWN_SYMBOLS: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

// Expected thresholds from the specification
const EXPECTED_THRESHOLDS: Record<CryptoAsset, { low: number; high: number }> = {
  BTC: { low: 0.0005, high: 0.0015 },
  ETH: { low: 0.0007, high: 0.0020 },
  SOL: { low: 0.0015, high: 0.0040 },
  XRP: { low: 0.0010, high: 0.0030 },
};

// ============================================================================
// Test Suite
// ============================================================================

describe('classifyVolatilityRegime', () => {
  // ==========================================================================
  // Per-Symbol Classification Tests
  // ==========================================================================

  describe('BTC classification', () => {
    const symbol = 'BTC' as CryptoAsset;
    const { low, high } = EXPECTED_THRESHOLDS.BTC;

    it('should classify low volatility correctly', () => {
      expect(classifyVolatilityRegime(0.0001, symbol)).toBe('low');
      expect(classifyVolatilityRegime(0.0003, symbol)).toBe('low');
      expect(classifyVolatilityRegime(low, symbol)).toBe('low'); // exactly at low threshold
    });

    it('should classify mid volatility correctly', () => {
      expect(classifyVolatilityRegime(low + 0.0001, symbol)).toBe('mid'); // just above low
      expect(classifyVolatilityRegime(0.0010, symbol)).toBe('mid');
      expect(classifyVolatilityRegime(high - 0.0001, symbol)).toBe('mid'); // just below high
    });

    it('should classify high volatility correctly', () => {
      expect(classifyVolatilityRegime(high, symbol)).toBe('high'); // exactly at high threshold
      expect(classifyVolatilityRegime(0.0020, symbol)).toBe('high');
      expect(classifyVolatilityRegime(0.0050, symbol)).toBe('high');
    });
  });

  describe('ETH classification', () => {
    const symbol = 'ETH' as CryptoAsset;
    const { low, high } = EXPECTED_THRESHOLDS.ETH;

    it('should classify low volatility correctly', () => {
      expect(classifyVolatilityRegime(0.0002, symbol)).toBe('low');
      expect(classifyVolatilityRegime(low, symbol)).toBe('low');
    });

    it('should classify mid volatility correctly', () => {
      expect(classifyVolatilityRegime(low + 0.0001, symbol)).toBe('mid');
      expect(classifyVolatilityRegime(0.0015, symbol)).toBe('mid');
      expect(classifyVolatilityRegime(high - 0.0001, symbol)).toBe('mid');
    });

    it('should classify high volatility correctly', () => {
      expect(classifyVolatilityRegime(high, symbol)).toBe('high');
      expect(classifyVolatilityRegime(0.0030, symbol)).toBe('high');
    });
  });

  describe('SOL classification', () => {
    const symbol = 'SOL' as CryptoAsset;
    const { low, high } = EXPECTED_THRESHOLDS.SOL;

    it('should classify low volatility correctly', () => {
      expect(classifyVolatilityRegime(0.0010, symbol)).toBe('low');
      expect(classifyVolatilityRegime(low, symbol)).toBe('low');
    });

    it('should classify mid volatility correctly', () => {
      expect(classifyVolatilityRegime(low + 0.0001, symbol)).toBe('mid');
      expect(classifyVolatilityRegime(0.0025, symbol)).toBe('mid');
      expect(classifyVolatilityRegime(high - 0.0001, symbol)).toBe('mid');
    });

    it('should classify high volatility correctly', () => {
      expect(classifyVolatilityRegime(high, symbol)).toBe('high');
      expect(classifyVolatilityRegime(0.0060, symbol)).toBe('high');
    });
  });

  describe('XRP classification', () => {
    const symbol = 'XRP' as CryptoAsset;
    const { low, high } = EXPECTED_THRESHOLDS.XRP;

    it('should classify low volatility correctly', () => {
      expect(classifyVolatilityRegime(0.0005, symbol)).toBe('low');
      expect(classifyVolatilityRegime(low, symbol)).toBe('low');
    });

    it('should classify mid volatility correctly', () => {
      expect(classifyVolatilityRegime(low + 0.0001, symbol)).toBe('mid');
      expect(classifyVolatilityRegime(0.0020, symbol)).toBe('mid');
      expect(classifyVolatilityRegime(high - 0.0001, symbol)).toBe('mid');
    });

    it('should classify high volatility correctly', () => {
      expect(classifyVolatilityRegime(high, symbol)).toBe('high');
      expect(classifyVolatilityRegime(0.0050, symbol)).toBe('high');
    });
  });

  // ==========================================================================
  // USDT Symbol Variants
  // ==========================================================================

  describe('USDT symbol variants', () => {
    it('should handle BTCUSDT same as BTC', () => {
      expect(classifyVolatilityRegime(0.0003, 'BTCUSDT')).toBe('low');
      expect(classifyVolatilityRegime(0.0010, 'BTCUSDT')).toBe('mid');
      expect(classifyVolatilityRegime(0.0020, 'BTCUSDT')).toBe('high');
    });

    it('should handle ETHUSDT same as ETH', () => {
      expect(classifyVolatilityRegime(0.0005, 'ETHUSDT')).toBe('low');
      expect(classifyVolatilityRegime(0.0015, 'ETHUSDT')).toBe('mid');
      expect(classifyVolatilityRegime(0.0025, 'ETHUSDT')).toBe('high');
    });

    it('should handle SOLUSDT same as SOL', () => {
      expect(classifyVolatilityRegime(0.0010, 'SOLUSDT')).toBe('low');
      expect(classifyVolatilityRegime(0.0025, 'SOLUSDT')).toBe('mid');
      expect(classifyVolatilityRegime(0.0050, 'SOLUSDT')).toBe('high');
    });

    it('should handle XRPUSDT same as XRP', () => {
      expect(classifyVolatilityRegime(0.0005, 'XRPUSDT')).toBe('low');
      expect(classifyVolatilityRegime(0.0020, 'XRPUSDT')).toBe('mid');
      expect(classifyVolatilityRegime(0.0040, 'XRPUSDT')).toBe('high');
    });
  });

  // ==========================================================================
  // Default Threshold Tests (Unknown Symbols)
  // ==========================================================================

  describe('unknown symbol handling', () => {
    it('should use default thresholds for unknown symbols', () => {
      // Default thresholds: low=0.001, high=0.003
      expect(classifyVolatilityRegime(0.0005, 'UNKNOWN' as CryptoAsset)).toBe('low');
      expect(classifyVolatilityRegime(0.001, 'UNKNOWN' as CryptoAsset)).toBe('low'); // at low
      expect(classifyVolatilityRegime(0.002, 'UNKNOWN' as CryptoAsset)).toBe('mid');
      expect(classifyVolatilityRegime(0.003, 'UNKNOWN' as CryptoAsset)).toBe('high'); // at high
      expect(classifyVolatilityRegime(0.005, 'UNKNOWN' as CryptoAsset)).toBe('high');
    });

    it('should handle empty string symbol with defaults', () => {
      expect(classifyVolatilityRegime(0.0005, '' as CryptoAsset)).toBe('low');
      expect(classifyVolatilityRegime(0.002, '' as CryptoAsset)).toBe('mid');
      expect(classifyVolatilityRegime(0.004, '' as CryptoAsset)).toBe('high');
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle zero volatility', () => {
      expect(classifyVolatilityRegime(0, 'BTC')).toBe('low');
      expect(classifyVolatilityRegime(0, 'ETH')).toBe('low');
      expect(classifyVolatilityRegime(0, 'SOL')).toBe('low');
      expect(classifyVolatilityRegime(0, 'XRP')).toBe('low');
    });

    it('should handle very high volatility', () => {
      expect(classifyVolatilityRegime(1.0, 'BTC')).toBe('high');
      expect(classifyVolatilityRegime(1.0, 'ETH')).toBe('high');
      expect(classifyVolatilityRegime(1.0, 'SOL')).toBe('high');
      expect(classifyVolatilityRegime(1.0, 'XRP')).toBe('high');
    });

    it('should handle negative volatility (edge case)', () => {
      // Volatility should never be negative in practice, but test defensively
      expect(classifyVolatilityRegime(-0.001, 'BTC')).toBe('low');
    });

    it('should handle exact boundary values', () => {
      // Test that boundary values are inclusive for low and high
      for (const symbol of KNOWN_SYMBOLS) {
        const { low, high } = EXPECTED_THRESHOLDS[symbol];
        expect(classifyVolatilityRegime(low, symbol)).toBe('low');
        expect(classifyVolatilityRegime(high, symbol)).toBe('high');
      }
    });

    it('should handle values just above low threshold', () => {
      for (const symbol of KNOWN_SYMBOLS) {
        const { low } = EXPECTED_THRESHOLDS[symbol];
        const justAboveLow = low + Number.EPSILON;
        expect(classifyVolatilityRegime(justAboveLow, symbol)).toBe('mid');
      }
    });

    it('should handle values just below high threshold', () => {
      for (const symbol of KNOWN_SYMBOLS) {
        const { high } = EXPECTED_THRESHOLDS[symbol];
        const justBelowHigh = high - Number.EPSILON;
        expect(classifyVolatilityRegime(justBelowHigh, symbol)).toBe('mid');
      }
    });
  });
});

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('getVolatilityThresholds', () => {
  it('should return correct thresholds for known symbols', () => {
    expect(getVolatilityThresholds('BTC')).toEqual({ low: 0.0005, high: 0.0015 });
    expect(getVolatilityThresholds('ETH')).toEqual({ low: 0.0007, high: 0.0020 });
    expect(getVolatilityThresholds('SOL')).toEqual({ low: 0.0015, high: 0.0040 });
    expect(getVolatilityThresholds('XRP')).toEqual({ low: 0.0010, high: 0.0030 });
  });

  it('should return correct thresholds for USDT variants', () => {
    expect(getVolatilityThresholds('BTCUSDT')).toEqual({ low: 0.0005, high: 0.0015 });
    expect(getVolatilityThresholds('ETHUSDT')).toEqual({ low: 0.0007, high: 0.0020 });
    expect(getVolatilityThresholds('SOLUSDT')).toEqual({ low: 0.0015, high: 0.0040 });
    expect(getVolatilityThresholds('XRPUSDT')).toEqual({ low: 0.0010, high: 0.0030 });
  });

  it('should return default thresholds for unknown symbols', () => {
    expect(getVolatilityThresholds('UNKNOWN')).toEqual({ low: 0.001, high: 0.003 });
    expect(getVolatilityThresholds('')).toEqual({ low: 0.001, high: 0.003 });
  });
});

describe('hasCustomThresholds', () => {
  it('should return true for known symbols', () => {
    expect(hasCustomThresholds('BTC')).toBe(true);
    expect(hasCustomThresholds('ETH')).toBe(true);
    expect(hasCustomThresholds('SOL')).toBe(true);
    expect(hasCustomThresholds('XRP')).toBe(true);
  });

  it('should return true for USDT variants', () => {
    expect(hasCustomThresholds('BTCUSDT')).toBe(true);
    expect(hasCustomThresholds('ETHUSDT')).toBe(true);
    expect(hasCustomThresholds('SOLUSDT')).toBe(true);
    expect(hasCustomThresholds('XRPUSDT')).toBe(true);
  });

  it('should return false for unknown symbols', () => {
    expect(hasCustomThresholds('UNKNOWN')).toBe(false);
    expect(hasCustomThresholds('')).toBe(false);
    expect(hasCustomThresholds('DOGE')).toBe(false);
  });
});
