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
import type { CryptoAsset } from './crypto15-feature-engine.js';

// ============================================================================
// Test Data
// ============================================================================

const KNOWN_SYMBOLS: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

// Test values for each symbol (values clearly in each regime)
const SYMBOL_TEST_DATA: Array<{
  symbol: CryptoAsset;
  lowVal: number;
  midVal: number;
  highVal: number;
}> = [
  { symbol: 'BTC', lowVal: 0.0001, midVal: 0.0010, highVal: 0.0020 },
  { symbol: 'ETH', lowVal: 0.0002, midVal: 0.0015, highVal: 0.0030 },
  { symbol: 'SOL', lowVal: 0.0010, midVal: 0.0025, highVal: 0.0060 },
  { symbol: 'XRP', lowVal: 0.0005, midVal: 0.0020, highVal: 0.0050 },
];

// ============================================================================
// Test Suite
// ============================================================================

describe('classifyVolatilityRegime', () => {
  // ==========================================================================
  // Per-Symbol Classification Tests (data-driven)
  // ==========================================================================

  describe.each(SYMBOL_TEST_DATA)(
    '$symbol classification',
    ({ symbol, lowVal, midVal, highVal }) => {
      const { low, high } = getVolatilityThresholds(symbol);

      it('should classify low volatility correctly', () => {
        expect(classifyVolatilityRegime(lowVal, symbol)).toBe('low');
        expect(classifyVolatilityRegime(low, symbol)).toBe('low'); // exactly at low threshold
      });

      it('should classify mid volatility correctly', () => {
        expect(classifyVolatilityRegime(low + 0.0001, symbol)).toBe('mid'); // just above low
        expect(classifyVolatilityRegime(midVal, symbol)).toBe('mid');
        expect(classifyVolatilityRegime(high - 0.0001, symbol)).toBe('mid'); // just below high
      });

      it('should classify high volatility correctly', () => {
        expect(classifyVolatilityRegime(high, symbol)).toBe('high'); // exactly at high threshold
        expect(classifyVolatilityRegime(highVal, symbol)).toBe('high');
      });
    }
  );

  // ==========================================================================
  // USDT Symbol Variants (data-driven)
  // ==========================================================================

  describe('USDT symbol variants', () => {
    it.each([
      { symbol: 'BTCUSDT', base: 'BTC', lowVal: 0.0003, midVal: 0.0010, highVal: 0.0020 },
      { symbol: 'ETHUSDT', base: 'ETH', lowVal: 0.0005, midVal: 0.0015, highVal: 0.0025 },
      { symbol: 'SOLUSDT', base: 'SOL', lowVal: 0.0010, midVal: 0.0025, highVal: 0.0050 },
      { symbol: 'XRPUSDT', base: 'XRP', lowVal: 0.0005, midVal: 0.0020, highVal: 0.0040 },
    ] as const)(
      'should handle $symbol same as $base',
      ({ symbol, base, lowVal, midVal, highVal }) => {
        // Verify thresholds match base symbol
        expect(getVolatilityThresholds(symbol)).toEqual(getVolatilityThresholds(base));

        // Verify classification works correctly
        expect(classifyVolatilityRegime(lowVal, symbol)).toBe('low');
        expect(classifyVolatilityRegime(midVal, symbol)).toBe('mid');
        expect(classifyVolatilityRegime(highVal, symbol)).toBe('high');
      }
    );
  });

  // ==========================================================================
  // Default Threshold Tests (Unknown Symbols)
  // ==========================================================================

  describe('unknown symbol handling', () => {
    it('should use default thresholds for unknown symbols', () => {
      const defaults = getVolatilityThresholds('UNKNOWN');
      expect(defaults).toEqual({ low: 0.001, high: 0.003 });

      expect(classifyVolatilityRegime(0.0005, 'UNKNOWN')).toBe('low');
      expect(classifyVolatilityRegime(0.001, 'UNKNOWN')).toBe('low'); // at low
      expect(classifyVolatilityRegime(0.002, 'UNKNOWN')).toBe('mid');
      expect(classifyVolatilityRegime(0.003, 'UNKNOWN')).toBe('high'); // at high
      expect(classifyVolatilityRegime(0.005, 'UNKNOWN')).toBe('high');
    });

    it('should handle empty string symbol with defaults', () => {
      expect(classifyVolatilityRegime(0.0005, '')).toBe('low');
      expect(classifyVolatilityRegime(0.002, '')).toBe('mid');
      expect(classifyVolatilityRegime(0.004, '')).toBe('high');
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it.each(KNOWN_SYMBOLS)('should handle zero volatility for %s', (symbol) => {
      expect(classifyVolatilityRegime(0, symbol)).toBe('low');
    });

    it.each(KNOWN_SYMBOLS)('should handle very high volatility for %s', (symbol) => {
      expect(classifyVolatilityRegime(1.0, symbol)).toBe('high');
    });

    it('should throw on negative volatility', () => {
      expect(() => classifyVolatilityRegime(-0.001, 'BTC')).toThrow(
        'Invalid volatility value: -0.001'
      );
    });

    it('should throw on NaN volatility', () => {
      expect(() => classifyVolatilityRegime(NaN, 'BTC')).toThrow(
        'Invalid volatility value: NaN'
      );
    });

    it('should throw on Infinity volatility', () => {
      expect(() => classifyVolatilityRegime(Infinity, 'BTC')).toThrow(
        'Invalid volatility value: Infinity'
      );
      expect(() => classifyVolatilityRegime(-Infinity, 'BTC')).toThrow(
        'Invalid volatility value: -Infinity'
      );
    });

    it('should handle exact boundary values', () => {
      for (const symbol of KNOWN_SYMBOLS) {
        const { low, high } = getVolatilityThresholds(symbol);
        expect(classifyVolatilityRegime(low, symbol)).toBe('low');
        expect(classifyVolatilityRegime(high, symbol)).toBe('high');
      }
    });

    it('should handle values just above low threshold', () => {
      for (const symbol of KNOWN_SYMBOLS) {
        const { low } = getVolatilityThresholds(symbol);
        const justAboveLow = low + Number.EPSILON;
        expect(classifyVolatilityRegime(justAboveLow, symbol)).toBe('mid');
      }
    });

    it('should handle values just below high threshold', () => {
      for (const symbol of KNOWN_SYMBOLS) {
        const { high } = getVolatilityThresholds(symbol);
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
  it.each([
    { symbol: 'BTC', expected: { low: 0.0005, high: 0.0015 } },
    { symbol: 'ETH', expected: { low: 0.0007, high: 0.0020 } },
    { symbol: 'SOL', expected: { low: 0.0015, high: 0.0040 } },
    { symbol: 'XRP', expected: { low: 0.0010, high: 0.0030 } },
  ])('should return correct thresholds for $symbol', ({ symbol, expected }) => {
    expect(getVolatilityThresholds(symbol)).toEqual(expected);
  });

  it.each(['BTC', 'ETH', 'SOL', 'XRP'] as const)(
    'should return same thresholds for %sUSDT as %s',
    (symbol) => {
      expect(getVolatilityThresholds(`${symbol}USDT`)).toEqual(
        getVolatilityThresholds(symbol)
      );
    }
  );

  it('should return default thresholds for unknown symbols', () => {
    expect(getVolatilityThresholds('UNKNOWN')).toEqual({ low: 0.001, high: 0.003 });
    expect(getVolatilityThresholds('')).toEqual({ low: 0.001, high: 0.003 });
  });
});

describe('hasCustomThresholds', () => {
  it.each(KNOWN_SYMBOLS)('should return true for %s', (symbol) => {
    expect(hasCustomThresholds(symbol)).toBe(true);
  });

  it.each(KNOWN_SYMBOLS)(
    'should return true for %sUSDT (normalized to base symbol)',
    (symbol) => {
      expect(hasCustomThresholds(`${symbol}USDT`)).toBe(true);
    }
  );

  it.each(['UNKNOWN', '', 'DOGE'])(
    'should return false for unknown symbol: %s',
    (symbol) => {
      expect(hasCustomThresholds(symbol)).toBe(false);
    }
  );

  it('should not be vulnerable to prototype pollution', () => {
    // These inherited properties should NOT be considered custom thresholds
    expect(hasCustomThresholds('__proto__')).toBe(false);
    expect(hasCustomThresholds('constructor')).toBe(false);
    expect(hasCustomThresholds('toString')).toBe(false);
  });
});
