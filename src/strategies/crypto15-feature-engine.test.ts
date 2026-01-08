/**
 * Crypto15FeatureEngine Unit Tests
 *
 * Tests feature computation with hardcoded examples to verify:
 * - Feature computation at minute boundaries only
 * - 32-minute continuous price buffer
 * - Window transitions (preserve buffer, reset state)
 * - NaN handling for insufficient data
 * - All feature calculations match specification
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Crypto15FeatureEngine,
  ASSET_THRESHOLDS,
  type FeatureVector,
  type CryptoAsset,
} from './crypto15-feature-engine.js';

describe('Crypto15FeatureEngine', () => {
  // Shared test constants
  const WINDOW_MS = 15 * 60 * 1000;
  const MINUTE_MS = 60000;
  const TEST_EPOCH = 1700000000000;
  const alignToWindowStart = (ts: number): number => Math.floor(ts / WINDOW_MS) * WINDOW_MS;

  let engine: Crypto15FeatureEngine;

  beforeEach(() => {
    engine = new Crypto15FeatureEngine('BTC');
  });

  describe('constructor', () => {
    it('should initialize with correct asset and threshold', () => {
      const btcEngine = new Crypto15FeatureEngine('BTC');
      expect(btcEngine.getState().asset).toBe('BTC');
      expect(btcEngine.getState().threshold).toBe(0.0008);

      const ethEngine = new Crypto15FeatureEngine('ETH');
      expect(ethEngine.getState().threshold).toBe(0.001);

      const solEngine = new Crypto15FeatureEngine('SOL');
      expect(solEngine.getState().threshold).toBe(0.002);

      const xrpEngine = new Crypto15FeatureEngine('XRP');
      expect(xrpEngine.getState().threshold).toBe(0.0015);
    });
  });

  describe('ASSET_THRESHOLDS', () => {
    it('should have correct threshold values', () => {
      expect(ASSET_THRESHOLDS.BTC).toBe(0.0008);  // 8 bps
      expect(ASSET_THRESHOLDS.ETH).toBe(0.001);   // 10 bps
      expect(ASSET_THRESHOLDS.SOL).toBe(0.002);   // 20 bps
      expect(ASSET_THRESHOLDS.XRP).toBe(0.0015);  // 15 bps
    });
  });

  describe('ingestPrice - minute boundary detection', () => {
    it('should return null for within-minute updates', () => {
      // First call at minute boundary should return features
      const t0 = 1700000000000; // Aligned to minute
      const result1 = engine.ingestPrice(50000, t0);
      expect(result1).not.toBeNull();

      // Same minute, different second - should return null
      const result2 = engine.ingestPrice(50001, t0 + 30000);
      expect(result2).toBeNull();
    });

    it('should return features at each new minute boundary', () => {
      const t0 = 1700000000000;

      const result1 = engine.ingestPrice(50000, t0);
      expect(result1).not.toBeNull();
      expect(result1?.stateMinute).toBeDefined();

      // Next minute
      const result2 = engine.ingestPrice(50100, t0 + 60000);
      expect(result2).not.toBeNull();
    });
  });

  describe('ingestPrice - time features', () => {
    it('should compute stateMinute and minutesRemaining correctly', () => {
      // Window start at minute 0 of a 15-minute window
      // Using timestamp that aligns to minute 0 of a 15-minute window
      const windowStart = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      const result0 = engine.ingestPrice(50000, windowStart);
      expect(result0?.stateMinute).toBe(0);
      expect(result0?.minutesRemaining).toBe(15);

      const result1 = engine.ingestPrice(50100, windowStart + 60000);
      expect(result1?.stateMinute).toBe(1);
      expect(result1?.minutesRemaining).toBe(14);

      const result5 = engine.ingestPrice(50200, windowStart + 5 * 60000);
      expect(result5?.stateMinute).toBe(5);
      expect(result5?.minutesRemaining).toBe(10);
    });

    it('should compute hourOfDay in UTC', () => {
      // Timestamp for 2023-11-14 15:30:00 UTC
      const timestamp = new Date('2023-11-14T15:30:00Z').getTime();
      const result = engine.ingestPrice(50000, timestamp);

      expect(result?.hourOfDay).toBe(15);
    });

    it('should compute dayOfWeek correctly', () => {
      // 2023-11-14 is a Tuesday (dayOfWeek = 2)
      const tuesday = new Date('2023-11-14T12:00:00Z').getTime();
      const result = engine.ingestPrice(50000, tuesday);
      expect(result?.dayOfWeek).toBe(2);
    });
  });

  describe('ingestPrice - return features', () => {
    it('should compute returnSinceOpen correctly', () => {
      const windowStart = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Open at 50000
      const result0 = engine.ingestPrice(50000, windowStart);
      expect(result0?.returnSinceOpen).toBeCloseTo(0, 10);

      // Price rises to 50100 (0.2% return)
      const result1 = engine.ingestPrice(50100, windowStart + 60000);
      expect(result1?.returnSinceOpen).toBeCloseTo(0.002, 6);

      // Price drops to 49900 (-0.2% return from open)
      const result2 = engine.ingestPrice(49900, windowStart + 2 * 60000);
      expect(result2?.returnSinceOpen).toBeCloseTo(-0.002, 6);
    });

    it('should return NaN for return features with insufficient data', () => {
      const t0 = 1700000000000;

      // First price - no history for lagged returns
      const result = engine.ingestPrice(50000, t0);

      expect(result?.return1m).toBeNaN();
      expect(result?.return3m).toBeNaN();
      expect(result?.return5m).toBeNaN();
    });

    it('should compute lagged returns with sufficient data', () => {
      const t0 = 1700000000000;

      // Build up history
      engine.ingestPrice(50000, t0);
      engine.ingestPrice(50100, t0 + 60000);
      engine.ingestPrice(50200, t0 + 2 * 60000);
      engine.ingestPrice(50300, t0 + 3 * 60000);
      engine.ingestPrice(50400, t0 + 4 * 60000);
      const result = engine.ingestPrice(50500, t0 + 5 * 60000);

      // return1m: 50500/50400 - 1 = 0.00198...
      expect(result?.return1m).toBeCloseTo(0.00198, 4);

      // return3m: 50500/50200 - 1 = 0.00598...
      expect(result?.return3m).toBeCloseTo(0.00598, 4);

      // return5m: 50500/50000 - 1 = 0.01
      expect(result?.return5m).toBeCloseTo(0.01, 4);
    });
  });

  describe('ingestPrice - max run-up/down', () => {
    it('should track maxRunUp within window', () => {
      const windowStart = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Open at 50000
      engine.ingestPrice(50000, windowStart);

      // Price rises to 50200 (0.4% run-up)
      engine.ingestPrice(50200, windowStart + 60000);

      // Price falls to 50100, but maxRunUp should still be 0.4%
      const result = engine.ingestPrice(50100, windowStart + 2 * 60000);

      expect(result?.maxRunUp).toBeCloseTo(0.004, 6);
    });

    it('should track maxRunDown within window', () => {
      const windowStart = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Open at 50000
      engine.ingestPrice(50000, windowStart);

      // Price drops to 49800 (0.4% run-down)
      engine.ingestPrice(49800, windowStart + 60000);

      // Price rises to 49900, but maxRunDown should still be -0.4%
      const result = engine.ingestPrice(49900, windowStart + 2 * 60000);

      expect(result?.maxRunDown).toBeCloseTo(-0.004, 6);
    });
  });

  describe('ingestPrice - volatility', () => {
    it('should return NaN for volatility with insufficient data', () => {
      const t0 = 1700000000000;

      // Less than 6 prices (need 5 returns)
      engine.ingestPrice(50000, t0);
      engine.ingestPrice(50100, t0 + 60000);
      const result = engine.ingestPrice(50200, t0 + 2 * 60000);

      expect(result?.volatility5m).toBeNaN();
    });

    it('should compute volatility with sufficient data', () => {
      const t0 = 1700000000000;

      // Build up 6 prices for 5 returns
      engine.ingestPrice(50000, t0);
      engine.ingestPrice(50100, t0 + 60000);  // +0.2%
      engine.ingestPrice(50200, t0 + 2 * 60000); // +0.2%
      engine.ingestPrice(50100, t0 + 3 * 60000); // -0.2%
      engine.ingestPrice(50200, t0 + 4 * 60000); // +0.2%
      const result = engine.ingestPrice(50300, t0 + 5 * 60000); // +0.2%

      // Returns: +0.2%, +0.2%, -0.2%, +0.2%, +0.2%
      // Mean = 0.12%
      // Should compute a small positive volatility
      expect(result?.volatility5m).toBeGreaterThan(0);
      expect(result?.volatility5m).toBeLessThan(0.01);
    });

    it('should compute zero volatility for constant price', () => {
      const t0 = 1700000000000;

      // All same price
      for (let i = 0; i < 6; i++) {
        engine.ingestPrice(50000, t0 + i * 60000);
      }

      const result = engine.ingestPrice(50000, t0 + 6 * 60000);

      // All returns are 0, so volatility = 0
      expect(result?.volatility5m).toBe(0);
    });
  });

  describe('ingestPrice - threshold hit tracking', () => {
    it('should track first up threshold hit for BTC (8bps)', () => {
      const windowStart = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Open at 50000
      engine.ingestPrice(50000, windowStart);

      // Price rises but below threshold
      const result1 = engine.ingestPrice(50030, windowStart + 60000);
      expect(result1?.hasUpHit).toBe(false);
      expect(result1?.firstUpHitMinute).toBeNaN();

      // Price hits threshold (50000 * 1.0008 = 50040)
      const result2 = engine.ingestPrice(50050, windowStart + 2 * 60000);
      expect(result2?.hasUpHit).toBe(true);
      expect(result2?.firstUpHitMinute).toBe(2);

      // Stays hit even if price drops
      const result3 = engine.ingestPrice(49950, windowStart + 3 * 60000);
      expect(result3?.hasUpHit).toBe(true);
      expect(result3?.firstUpHitMinute).toBe(2);
    });

    it('should track first down threshold hit', () => {
      const windowStart = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Open at 50000
      engine.ingestPrice(50000, windowStart);

      // Price drops below threshold (50000 * 0.9992 = 49960)
      const result = engine.ingestPrice(49950, windowStart + 60000);

      expect(result?.hasDownHit).toBe(true);
      expect(result?.firstDownHitMinute).toBe(1);
    });

    it('should work correctly with ETH threshold (10bps)', () => {
      const ethEngine = new Crypto15FeatureEngine('ETH');
      const windowStart = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Open at 2000
      ethEngine.ingestPrice(2000, windowStart);

      // Just below threshold (2000 * 1.001 = 2002)
      const result1 = ethEngine.ingestPrice(2001.5, windowStart + 60000);
      expect(result1?.hasUpHit).toBe(false);

      // At threshold
      const result2 = ethEngine.ingestPrice(2002.1, windowStart + 2 * 60000);
      expect(result2?.hasUpHit).toBe(true);
    });
  });

  describe('window transitions', () => {
    it('should reset window state on new window', () => {
      // First window
      const window1Start = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      engine.ingestPrice(50000, window1Start);
      engine.ingestPrice(50100, window1Start + 60000);

      const lastInWindow1 = engine.ingestPrice(50200, window1Start + 2 * 60000);
      expect(lastInWindow1?.maxRunUp).toBeCloseTo(0.004, 6);

      // New window (15 minutes later)
      const window2Start = window1Start + 15 * 60000;
      const firstInWindow2 = engine.ingestPrice(50200, window2Start);

      // Max run-up should reset to 0 in new window
      expect(firstInWindow2?.maxRunUp).toBe(0);
      expect(firstInWindow2?.stateMinute).toBe(0);
    });

    it('should preserve price buffer across windows', () => {
      const window1Start = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Build up history in first window
      for (let i = 0; i < 10; i++) {
        engine.ingestPrice(50000 + i * 10, window1Start + i * 60000);
      }

      expect(engine.getState().bufferSize).toBe(10);

      // New window
      const window2Start = window1Start + 15 * 60000;
      engine.ingestPrice(50100, window2Start);

      // Buffer should still have history
      expect(engine.getState().bufferSize).toBe(11);

      // Should be able to compute lagged returns
      const result = engine.ingestPrice(50200, window2Start + 60000);
      expect(result?.return1m).not.toBeNaN();
    });

    it('should reset threshold hits on new window', () => {
      const window1Start = Math.floor(1700000000000 / (15 * 60 * 1000)) * (15 * 60 * 1000);

      // Hit threshold in first window
      engine.ingestPrice(50000, window1Start);
      engine.ingestPrice(50050, window1Start + 60000);

      const lastInWindow1 = engine.ingestPrice(50050, window1Start + 2 * 60000);
      expect(lastInWindow1?.hasUpHit).toBe(true);

      // New window
      const window2Start = window1Start + 15 * 60000;
      const firstInWindow2 = engine.ingestPrice(50050, window2Start);

      // Threshold hit should reset
      expect(firstInWindow2?.hasUpHit).toBe(false);
      expect(firstInWindow2?.firstUpHitMinute).toBeNaN();
    });
  });

  describe('buffer management', () => {
    it('should maintain buffer at 32 prices max', () => {
      const t0 = 1700000000000;

      // Ingest 40 prices
      for (let i = 0; i < 40; i++) {
        engine.ingestPrice(50000 + i, t0 + i * 60000);
      }

      expect(engine.getState().bufferSize).toBe(32);
    });
  });

  describe('toFeatureMap', () => {
    it('should convert FeatureVector to flat map', () => {
      const features: FeatureVector = {
        stateMinute: 5,
        minutesRemaining: 10,
        hourOfDay: 14,
        dayOfWeek: 2,
        returnSinceOpen: 0.002,
        maxRunUp: 0.003,
        maxRunDown: -0.001,
        return1m: 0.001,
        return3m: 0.002,
        return5m: 0.003,
        volatility5m: 0.0015,
        hasUpHit: true,
        hasDownHit: false,
        firstUpHitMinute: 3,
        firstDownHitMinute: NaN,
        asset: 'BTC',
        timestamp: 1700000000000,
      };

      const map = Crypto15FeatureEngine.toFeatureMap(features);

      expect(map.state_minute).toBe(5);
      expect(map.minutes_remaining).toBe(10);
      expect(map.hour_of_day).toBe(14);
      expect(map.day_of_week).toBe(2);
      expect(map.return_since_open).toBe(0.002);
      expect(map.max_run_up).toBe(0.003);
      expect(map.max_run_down).toBe(-0.001);
      expect(map.return_1m).toBe(0.001);
      expect(map.return_3m).toBe(0.002);
      expect(map.return_5m).toBe(0.003);
      expect(map.volatility_5m).toBe(0.0015);
      expect(map.has_up_hit).toBe(true);
      expect(map.has_down_hit).toBe(false);
      expect(map.first_up_hit_minute).toBe(3);
      expect(map.first_down_hit_minute).toBeNaN();
      expect(map.asset).toBe(0); // BTC = 0
    });

    it('should map assets to correct numbers', () => {
      const makeFeatures = (asset: CryptoAsset): FeatureVector => ({
        stateMinute: 0,
        minutesRemaining: 15,
        hourOfDay: 12,
        dayOfWeek: 0,
        returnSinceOpen: 0,
        maxRunUp: 0,
        maxRunDown: 0,
        return1m: NaN,
        return3m: NaN,
        return5m: NaN,
        volatility5m: NaN,
        hasUpHit: false,
        hasDownHit: false,
        firstUpHitMinute: NaN,
        firstDownHitMinute: NaN,
        asset,
        timestamp: 1700000000000,
      });

      expect(Crypto15FeatureEngine.toFeatureMap(makeFeatures('BTC')).asset).toBe(0);
      expect(Crypto15FeatureEngine.toFeatureMap(makeFeatures('ETH')).asset).toBe(1);
      expect(Crypto15FeatureEngine.toFeatureMap(makeFeatures('SOL')).asset).toBe(2);
      expect(Crypto15FeatureEngine.toFeatureMap(makeFeatures('XRP')).asset).toBe(3);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const t0 = 1700000000000;

      // Build up state
      for (let i = 0; i < 10; i++) {
        engine.ingestPrice(50000 + i * 10, t0 + i * 60000);
      }

      expect(engine.getState().bufferSize).toBe(10);
      expect(engine.getState().windowState).not.toBeNull();

      // Reset
      engine.reset();

      expect(engine.getState().bufferSize).toBe(0);
      expect(engine.getState().windowState).toBeNull();
      expect(engine.getState().lastMinute).toBe(-1);
    });
  });

  describe('edge cases', () => {
    const BUFFER_BUILD_COUNT = 10;

    it('should handle first market scenario (no price history)', () => {
      // Edge case: First market ever - no prior price data
      // All lookback features should be NaN
      const engine = new Crypto15FeatureEngine('BTC');
      const windowStart = alignToWindowStart(TEST_EPOCH);

      const result = engine.ingestPrice(50000, windowStart);

      // Verify we got a result
      expect(result).not.toBeNull();

      // Time features should be valid
      expect(result!.stateMinute).toBe(0);
      expect(result!.minutesRemaining).toBe(15);

      // Return features should be NaN (insufficient history)
      expect(result!.return1m).toBeNaN();
      expect(result!.return3m).toBeNaN();
      expect(result!.return5m).toBeNaN();
      expect(result!.volatility5m).toBeNaN();

      // Window-relative features should be valid (use toBeCloseTo for floats)
      expect(result!.returnSinceOpen).toBeCloseTo(0);
      expect(result!.maxRunUp).toBeCloseTo(0);
      expect(result!.maxRunDown).toBeCloseTo(0);
    });

    it('should handle early state minutes (0, 1, 2) with lookback from previous window', () => {
      // Simulates real scenario: buffer built up, now at minute 0-2 of new window
      const engine = new Crypto15FeatureEngine('BTC');

      // Build buffer in first window: prices at minutes 0-9
      // minute 0: 50000, 1: 50010, 2: 50020, ..., 9: 50090
      const window1Start = alignToWindowStart(TEST_EPOCH);
      for (let i = 0; i < BUFFER_BUILD_COUNT; i++) {
        engine.ingestPrice(50000 + i * 10, window1Start + i * MINUTE_MS);
      }

      // New window starts at minute 15
      const window2Start = window1Start + WINDOW_MS;

      // Minute 0 of new window (price 50100) - lookback to minute 9 (50090)
      const result0 = engine.ingestPrice(50100, window2Start);
      expect(result0).not.toBeNull();
      expect(result0!.stateMinute).toBe(0);
      // return1m: (50100 - 50090) / 50090
      expect(result0!.return1m).toBeCloseTo((50100 - 50090) / 50090, 6);

      // Minute 1 of new window (price 50150)
      // 1m ago: 50100, 3m ago: minute 8 = 50080
      const result1 = engine.ingestPrice(50150, window2Start + MINUTE_MS);
      expect(result1).not.toBeNull();
      expect(result1!.stateMinute).toBe(1);
      expect(result1!.return1m).toBeCloseTo((50150 - 50100) / 50100, 6);
      expect(result1!.return3m).toBeCloseTo((50150 - 50080) / 50080, 6);

      // Minute 2 of new window (price 50200) - entry window boundary
      // 1m ago: 50150, 3m ago: minute 9 = 50090, 5m ago: minute 7 = 50070
      const result2 = engine.ingestPrice(50200, window2Start + 2 * MINUTE_MS);
      expect(result2).not.toBeNull();
      expect(result2!.stateMinute).toBe(2);
      expect(result2!.return1m).toBeCloseTo((50200 - 50150) / 50150, 6);
      expect(result2!.return3m).toBeCloseTo((50200 - 50090) / 50090, 6);
      expect(result2!.return5m).toBeCloseTo((50200 - 50070) / 50070, 6);
    });

    it('should handle price of 0', () => {
      const t0 = 1700000000000;
      engine.ingestPrice(50000, t0);

      // Price drops to near zero
      const result = engine.ingestPrice(0.01, t0 + 60000);

      expect(result?.returnSinceOpen).toBeCloseTo(-0.9999998, 5);
    });

    it('should handle very small price movements', () => {
      const t0 = 1700000000000;
      engine.ingestPrice(50000, t0);
      const result = engine.ingestPrice(50000.01, t0 + 60000);

      expect(result?.returnSinceOpen).toBeCloseTo(0.0000002, 10);
    });

    it('should handle large price movements', () => {
      const t0 = 1700000000000;
      engine.ingestPrice(50000, t0);
      const result = engine.ingestPrice(100000, t0 + 60000);

      expect(result?.returnSinceOpen).toBeCloseTo(1.0, 6);
    });
  });

  describe('issue specification example', () => {
    /**
     * Tests the example from issue #4 spec.
     * Note: Actual API uses (asset) constructor; BTC has 0.0008 threshold.
     */
    it('should match the example from issue #4 spec', () => {
      const engine = new Crypto15FeatureEngine('BTC');

      // First price at minute boundary - returns features (minute 0 is valid)
      const timestamp1 = new Date('2024-01-08T14:00:00Z').getTime();
      const features1 = engine.ingestPrice(98500, timestamp1);
      expect(features1).not.toBeNull();
      expect(features1!.stateMinute).toBe(0);
      expect(features1!.returnSinceOpen).toBeCloseTo(0, 6);

      // Second price at next minute
      const timestamp2 = new Date('2024-01-08T14:01:00Z').getTime();
      const features2 = engine.ingestPrice(98550, timestamp2);
      expect(features2).not.toBeNull();
      expect(features2!.stateMinute).toBe(1);

      // Expected: (98550 - 98500) / 98500 = 50 / 98500 ≈ 0.0005076
      const expectedReturn = (98550 - 98500) / 98500;
      expect(features2!.returnSinceOpen).toBeCloseTo(expectedReturn, 6);
    });
  });

  describe('integration scenario: full 15-minute window', () => {
    it('should track features across a complete window', () => {
      const windowStart = alignToWindowStart(TEST_EPOCH);
      const prices = [
        50000, 50020, 50050, 50030, 50080, // 0-4: gradual rise
        50100, 50090, 50070, 50050, 50060, // 5-9: peak and consolidation
        50040, 50020, 50000, 49980, 49990, // 10-14: decline
      ];

      const results: FeatureVector[] = [];

      for (let i = 0; i < 15; i++) {
        const result = engine.ingestPrice(prices[i], windowStart + i * MINUTE_MS);
        if (result) results.push(result);
      }

      expect(results.length).toBe(15);

      // Check first minute
      expect(results[0].stateMinute).toBe(0);
      expect(results[0].returnSinceOpen).toBe(0);

      // Check peak tracking (max was 50100 at minute 5)
      const finalResult = results[14];
      expect(finalResult.maxRunUp).toBeCloseTo(0.002, 4); // 50100/50000 - 1

      // Check final state
      expect(finalResult.stateMinute).toBe(14);
      expect(finalResult.minutesRemaining).toBe(1);

      // Return since open at end
      expect(finalResult.returnSinceOpen).toBeCloseTo(-0.0002, 5); // 49990/50000 - 1

      // Up threshold should have been hit (BTC: 8bps = 0.08%)
      // 50050/50000 - 1 = 0.1% > 0.08%, so hit at minute 2
      expect(finalResult.hasUpHit).toBe(true);
      expect(finalResult.firstUpHitMinute).toBe(2);
    });
  });
});
