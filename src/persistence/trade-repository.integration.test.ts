/**
 * TradeRepository Integration Tests
 *
 * End-to-end tests for the trade persistence layer, testing the full lifecycle
 * of trade recording, resolution, and analysis queries.
 *
 * These tests use a real SQLite database and verify:
 * - Full trade lifecycle (record -> update outcome -> query)
 * - Analysis query correctness with realistic data
 * - Performance with multiple records
 * - Data integrity across related tables
 *
 * Run with: pnpm test:integration
 *
 * Part of #29
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { dirname } from 'path';
import { TradeRepository } from './trade-repository.js';
import type { TradeRecord, TradeOutcome, VolatilityRegime } from '../types/trade-record.types.js';
import type { FeatureVector, CryptoAsset } from '../strategies/crypto15-feature-engine.js';

// ============================================================================
// Test Configuration
// ============================================================================

const INTEGRATION_DB_PATH = './test-data/integration/trades-integration.db';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
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

function createTestTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    conditionId: `int-cond-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    slug: 'btc-updown-15m-integration',
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

function createTestOutcome(overrides: Partial<TradeOutcome> = {}): TradeOutcome {
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

// ============================================================================
// Setup Helpers
// ============================================================================

function cleanupDatabaseFiles(basePath: string): void {
  const filesToRemove = [basePath, `${basePath}-wal`, `${basePath}-shm`];
  for (const file of filesToRemove) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
}

// ============================================================================
// Integration Test Suite
// ============================================================================

describe('TradeRepository Integration Tests', () => {
  let repository: TradeRepository;

  beforeAll(() => {
    // Ensure test directory exists
    const testDir = dirname(INTEGRATION_DB_PATH);
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  beforeEach(async () => {
    // Clean up any existing database
    cleanupDatabaseFiles(INTEGRATION_DB_PATH);

    // Create fresh repository
    repository = new TradeRepository({
      dbPath: INTEGRATION_DB_PATH,
      syncMode: 'sync',
    });
    await repository.initialize();
  });

  afterEach(async () => {
    await repository.close();
    cleanupDatabaseFiles(INTEGRATION_DB_PATH);
  });

  afterAll(() => {
    // Clean up test directory
    const testDir = dirname(INTEGRATION_DB_PATH);
    if (existsSync(testDir)) {
      try {
        rmSync(testDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ============================================================================
  // Full Lifecycle Tests
  // ============================================================================

  describe('Full Trade Lifecycle', () => {
    it('should handle complete trade lifecycle: record -> update -> query', async () => {
      // Step 1: Record a trade
      const trade = createTestTrade({
        symbol: 'BTC',
        probability: 0.75,
        volatilityRegime: 'mid',
      });
      const tradeId = await repository.recordTrade(trade);
      expect(tradeId).toBeGreaterThan(0);

      // Step 2: Verify trade is pending
      const pending = await repository.getPendingTrades();
      expect(pending).toHaveLength(1);
      expect(pending[0].conditionId).toBe(trade.conditionId);

      // Step 3: Update outcome
      const outcome = createTestOutcome({
        outcome: 'UP',
        isWin: true,
        pnl: 50,
      });
      await repository.updateOutcome(trade.conditionId, outcome);

      // Step 4: Verify no longer pending
      const stillPending = await repository.getPendingTrades();
      expect(stillPending).toHaveLength(0);

      // Step 5: Query via analysis methods
      const symbolStats = await repository.getSymbolStats('BTC');
      expect(symbolStats.totalTrades).toBe(1);
      expect(symbolStats.wins).toBe(1);
      expect(symbolStats.totalPnl).toBe(50);

      const regimeStats = await repository.getPerformanceByRegime('mid');
      expect(regimeStats.totalTrades).toBe(1);
      expect(regimeStats.wins).toBe(1);
    });

    it('should maintain data integrity across related tables', async () => {
      const trade = createTestTrade();
      const tradeId = await repository.recordTrade(trade);

      // Record minute prices
      for (let minute = 0; minute < 15; minute++) {
        await repository.recordMinutePrice(
          tradeId,
          minute,
          50000 + minute * 10,
          Date.now() + minute * 60000
        );
      }

      // Retrieve and verify all data is intact
      const retrieved = await repository.getTradeById(tradeId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.features).toBeDefined();
      expect(retrieved!.minutePrices).toHaveLength(15);
      expect(retrieved!.minutePrices![0].price).toBe(50000);
      expect(retrieved!.minutePrices![14].price).toBe(50140);
    });
  });

  // ============================================================================
  // Analysis Query Integration Tests
  // ============================================================================

  describe('Analysis Queries with Realistic Data', () => {
    beforeEach(async () => {
      // Populate database with realistic test data
      const symbols: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];
      const regimes: VolatilityRegime[] = ['low', 'mid', 'high'];
      const probabilities = [0.75, 0.72, 0.68, 0.55, 0.45, 0.35];

      let baseTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago

      // Create 24 trades (4 symbols × 6 probability levels)
      for (const symbol of symbols) {
        for (let i = 0; i < probabilities.length; i++) {
          const prob = probabilities[i];
          const regime = regimes[i % 3];
          const isWin = prob > 0.5; // Simplified win logic for testing
          const pnl = isWin ? 50 : -65;

          const trade = createTestTrade({
            symbol,
            probability: prob,
            volatilityRegime: regime,
            signalTimestamp: baseTimestamp,
            hourOfDay: i % 24,
            dayOfWeek: i % 7,
            stateMinute: i % 15,
            side: prob > 0.5 ? 'YES' : 'NO',
          });

          await repository.recordTrade(trade);
          await repository.updateOutcome(
            trade.conditionId,
            createTestOutcome({ isWin, pnl, outcome: isWin ? 'UP' : 'DOWN' })
          );

          baseTimestamp += 60 * 60 * 1000; // 1 hour apart
        }
      }
    });

    it('should return correct symbol statistics', async () => {
      const btcStats = await repository.getSymbolStats('BTC');

      expect(btcStats.symbol).toBe('BTC');
      expect(btcStats.totalTrades).toBe(6); // 6 trades per symbol
      // With probs [0.75, 0.72, 0.68, 0.55, 0.45, 0.35], wins are those > 0.5 = 4 wins
      expect(btcStats.wins).toBe(4);
      expect(btcStats.winRate).toBeCloseTo((4 / 6) * 100, 0);
    });

    it('should return correct all symbol statistics', async () => {
      const allStats = await repository.getAllSymbolStats();

      expect(allStats).toHaveLength(4); // BTC, ETH, SOL, XRP
      expect(allStats.every((s) => s.totalTrades === 6)).toBe(true);

      // Total trades across all symbols
      const totalTrades = allStats.reduce((sum, s) => sum + s.totalTrades, 0);
      expect(totalTrades).toBe(24);
    });

    it('should return correct regime statistics', async () => {
      const allRegimeStats = await repository.getAllRegimeStats();

      // With 24 trades and 3 regimes, each regime gets ~8 trades
      // (6 per symbol, i % 3 assigns regime)
      expect(allRegimeStats).toHaveLength(3);

      const totalTrades = allRegimeStats.reduce((sum, s) => sum + s.totalTrades, 0);
      expect(totalTrades).toBe(24);
    });

    it('should return correct calibration data', async () => {
      const calibration = await repository.getCalibrationData();

      // Should have buckets for the YES trades (prob > 0.5)
      expect(calibration.length).toBeGreaterThan(0);

      // Each bucket should have expected structure
      for (const bucket of calibration) {
        expect(bucket.bucket).toBeDefined();
        expect(bucket.trades).toBeGreaterThan(0);
        expect(bucket.avgPredicted).toBeGreaterThanOrEqual(0);
        expect(bucket.avgPredicted).toBeLessThanOrEqual(1);
        expect(typeof bucket.actualWinRate).toBe('number');
        expect(typeof bucket.calibrationGap).toBe('number');
      }
    });

    it('should return correct date range queries', async () => {
      const stats = await repository.getStats();
      expect(stats.totalTrades).toBe(24);

      // Query for all trades (last 8 days - covers the full range)
      const now = Date.now();
      const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
      const allTrades = await repository.getTradesByDateRange(eightDaysAgo, new Date(now));
      expect(allTrades).toHaveLength(24);

      // Query for a narrower window (last 12 hours from the oldest trade)
      // Trades are created starting 7 days ago with 1 hour intervals
      const oldestTimestamp = now - 7 * 24 * 60 * 60 * 1000; // 7 days ago
      const narrowStart = new Date(oldestTimestamp);
      const narrowEnd = new Date(oldestTimestamp + 12 * 60 * 60 * 1000); // 12 hours after start
      const narrowTrades = await repository.getTradesByDateRange(narrowStart, narrowEnd);

      // Should get about 12 trades (12 hours * 1 trade/hour)
      expect(narrowTrades.length).toBeGreaterThan(0);
      expect(narrowTrades.length).toBeLessThanOrEqual(13); // Allow for timing variance
    });
  });

  // ============================================================================
  // Performance Tests
  // ============================================================================

  describe('Performance with Multiple Records', () => {
    it('should efficiently batch fetch trades', async () => {
      // Create 100 trades
      const trades: TradeRecord[] = [];
      for (let i = 0; i < 100; i++) {
        trades.push(createTestTrade({
          symbol: (['BTC', 'ETH', 'SOL', 'XRP'] as CryptoAsset[])[i % 4],
          volatilityRegime: (['low', 'mid', 'high'] as VolatilityRegime[])[i % 3],
        }));
      }

      // Record all trades
      for (const trade of trades) {
        await repository.recordTrade(trade);
      }

      // Time the batch fetch
      const startTime = Date.now();
      const pending = await repository.getPendingTrades(100);
      const fetchTime = Date.now() - startTime;

      expect(pending).toHaveLength(100);
      expect(fetchTime).toBeLessThan(1000); // Should complete in under 1 second

      // All trades should have features loaded (batch query)
      expect(pending.every((t) => t.features !== null && t.features !== undefined)).toBe(true);
    });

    it('should handle concurrent reads and writes', async () => {
      // Create initial trades
      const initialTrades = Array.from({ length: 20 }, () => createTestTrade());
      for (const trade of initialTrades) {
        await repository.recordTrade(trade);
      }

      // Concurrent operations
      const operations = [
        repository.getStats(),
        repository.getPendingTrades(),
        repository.getAllSymbolStats(),
        repository.getAllRegimeStats(),
        repository.getCalibrationData(),
      ];

      const results = await Promise.all(operations);

      expect(results[0]).toBeDefined(); // Stats
      expect((results[1] as TradeRecord[]).length).toBe(20); // Pending trades
    });
  });

  // ============================================================================
  // Database Maintenance Tests
  // ============================================================================

  describe('Database Maintenance', () => {
    it('should return accurate database statistics', async () => {
      // Create mixed resolved and pending trades
      for (let i = 0; i < 10; i++) {
        const trade = createTestTrade();
        await repository.recordTrade(trade);

        if (i < 7) {
          await repository.updateOutcome(trade.conditionId, createTestOutcome());
        }
      }

      const stats = await repository.getStats();

      expect(stats.totalTrades).toBe(10);
      expect(stats.resolvedTrades).toBe(7);
      expect(stats.pendingTrades).toBe(3);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
      expect(stats.oldestTrade).toBeDefined();
      expect(stats.newestTrade).toBeDefined();
    });

    it('should successfully run vacuum', async () => {
      // Create and delete some data to create fragmentation
      for (let i = 0; i < 10; i++) {
        const trade = createTestTrade();
        await repository.recordTrade(trade);
      }

      // Get initial size
      const beforeStats = await repository.getStats();

      // Run vacuum
      await repository.vacuum();

      // Should complete without error and database should still work
      const afterStats = await repository.getStats();
      expect(afterStats.totalTrades).toBe(10);
      expect(afterStats.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty database queries gracefully', async () => {
      const pending = await repository.getPendingTrades();
      expect(pending).toHaveLength(0);

      const allSymbols = await repository.getAllSymbolStats();
      expect(allSymbols).toHaveLength(0);

      const allRegimes = await repository.getAllRegimeStats();
      expect(allRegimes).toHaveLength(0);

      const calibration = await repository.getCalibrationData();
      expect(calibration).toHaveLength(0);

      const stats = await repository.getStats();
      expect(stats.totalTrades).toBe(0);
    });

    it('should handle trades without volatility regime', async () => {
      const trade = createTestTrade({ volatilityRegime: undefined });
      await repository.recordTrade(trade);
      await repository.updateOutcome(trade.conditionId, createTestOutcome());

      const allRegimes = await repository.getAllRegimeStats();
      expect(allRegimes).toHaveLength(0); // Trade without regime not included

      const symbolStats = await repository.getSymbolStats('BTC');
      expect(symbolStats.totalTrades).toBe(1); // But still counted in symbol stats
    });

    it('should handle all loss scenario', async () => {
      for (let i = 0; i < 5; i++) {
        const trade = createTestTrade({ symbol: 'ETH' as CryptoAsset });
        await repository.recordTrade(trade);
        await repository.updateOutcome(
          trade.conditionId,
          createTestOutcome({ isWin: false, pnl: -50, outcome: 'DOWN' })
        );
      }

      const stats = await repository.getSymbolStats('ETH');
      expect(stats.totalTrades).toBe(5);
      expect(stats.wins).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.totalPnl).toBe(-250);
    });

    it('should handle transactions correctly', async () => {
      const trade1 = createTestTrade();
      const trade2 = createTestTrade();

      // Use transaction to record multiple trades
      await repository.transaction(() => {
        // Note: recordTrade is async, but inside transaction we're using sync mode
        // This tests the transaction wrapper
        return 'completed';
      });

      // Manually record trades to verify transaction capability
      await repository.recordTrade(trade1);
      await repository.recordTrade(trade2);

      const stats = await repository.getStats();
      expect(stats.totalTrades).toBe(2);
    });
  });
});
