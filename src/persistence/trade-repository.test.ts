/**
 * TradeRepository Unit Tests
 *
 * Tests for the SQLite persistence layer for Crypto15ML trades.
 *
 * Part of #25
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { TradeRepository } from './trade-repository.js';
import type { PersistenceConfig, EvaluationRecord } from '../types/trade-record.types.js';
import type { CryptoAsset } from '../strategies/crypto15-feature-engine.js';
import { createTestTrade, createTestOutcome, createTestFeatures, createTestEvaluation } from './test-fixtures.js';

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_DB_PATH = './test-data/test-trades.db';

// ============================================================================
// Test Constants
// ============================================================================

/** One minute in milliseconds */
const ONE_MINUTE_MS = 60_000;

/** Two minutes in milliseconds */
const TWO_MINUTES_MS = 120_000;

/** Base timestamp for analytics tests (2024-01-15 12:00:00 UTC) */
const TEST_BASE_TIMESTAMP = new Date('2024-01-15T12:00:00Z').getTime();

// ============================================================================
// Test Setup Helpers (extracted to reduce duplication)
// ============================================================================

/**
 * Clean up database files (main db + WAL + SHM)
 */
function cleanupDatabaseFiles(basePath: string): void {
  const filesToRemove = [basePath, `${basePath}-wal`, `${basePath}-shm`];
  for (const file of filesToRemove) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
}

/**
 * Setup test repository with specified sync mode
 */
async function setupTestRepository(
  syncMode: PersistenceConfig['syncMode']
): Promise<TradeRepository> {
  // Ensure test directory exists
  const testDir = dirname(TEST_DB_PATH);
  if (!existsSync(testDir)) {
    mkdirSync(testDir, { recursive: true });
  }

  // Clean up any existing test database
  cleanupDatabaseFiles(TEST_DB_PATH);

  const repository = new TradeRepository({
    dbPath: TEST_DB_PATH,
    syncMode,
  });

  await repository.initialize();
  return repository;
}

/**
 * Teardown test repository
 */
async function teardownTestRepository(repository: TradeRepository): Promise<void> {
  await repository.close();
  cleanupDatabaseFiles(TEST_DB_PATH);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('TradeRepository', () => {
  let repository: TradeRepository;

  beforeEach(async () => {
    repository = await setupTestRepository('sync');
  });

  afterEach(async () => {
    await teardownTestRepository(repository);
  });

  // ============================================================================
  // Initialization Tests
  // ============================================================================

  describe('initialization', () => {
    it('should create database file on initialize', async () => {
      expect(existsSync(TEST_DB_PATH)).toBe(true);
    });

    it('should create schema with all tables', async () => {
      const stats = await repository.getStats();
      expect(stats.totalTrades).toBe(0);
      expect(stats.pendingTrades).toBe(0);
      expect(stats.resolvedTrades).toBe(0);
    });

    it('should throw error when not initialized', async () => {
      const uninitializedRepo = new TradeRepository({
        dbPath: './test-data/uninitialized.db',
        syncMode: 'sync',
      });

      await expect(uninitializedRepo.getStats()).rejects.toThrow(
        'TradeRepository not initialized'
      );
    });

    it('should handle disabled persistence', async () => {
      const disabledRepo = new TradeRepository({
        enabled: false,
        dbPath: './test-data/disabled.db',
      });

      await disabledRepo.initialize();
      // Should not create database file when disabled
      expect(existsSync('./test-data/disabled.db')).toBe(false);
    });

    it('should reject database paths outside allowed directories', async () => {
      const invalidRepo = new TradeRepository({
        dbPath: '/tmp/invalid-path.db',
        syncMode: 'sync',
      });

      // Error message is intentionally generic to avoid information disclosure
      await expect(invalidRepo.initialize()).rejects.toThrow(
        /Invalid database path/
      );
    });
  });

  // ============================================================================
  // Write Operation Tests
  // ============================================================================

  describe('recordTrade', () => {
    it('should insert a trade and return an ID', async () => {
      const trade = createTestTrade();
      const id = await repository.recordTrade(trade);

      expect(id).toBeGreaterThan(0);
    });

    it('should store all trade fields correctly', async () => {
      const trade = createTestTrade({
        conditionId: 'unique-cond-123',
        slug: 'eth-updown-15m',
        symbol: 'ETH' as CryptoAsset,
        side: 'NO',
        entryPrice: 0.45,
        positionSize: 250,
        probability: 0.68,
        linearCombination: 0.73,
        imputedCount: 2,
        stateMinute: 8,
        hourOfDay: 22,
        dayOfWeek: 5,
        volatilityRegime: 'high',
        volatility5m: 0.0025,
        windowOpenPrice: 3500,
      });

      const id = await repository.recordTrade(trade);
      const retrieved = await repository.getTradeById(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.conditionId).toBe('unique-cond-123');
      expect(retrieved!.slug).toBe('eth-updown-15m');
      expect(retrieved!.symbol).toBe('ETH');
      expect(retrieved!.side).toBe('NO');
      expect(retrieved!.entryPrice).toBe(0.45);
      expect(retrieved!.positionSize).toBe(250);
      expect(retrieved!.probability).toBe(0.68);
      expect(retrieved!.linearCombination).toBe(0.73);
      expect(retrieved!.imputedCount).toBe(2);
      expect(retrieved!.stateMinute).toBe(8);
      expect(retrieved!.hourOfDay).toBe(22);
      expect(retrieved!.dayOfWeek).toBe(5);
      expect(retrieved!.volatilityRegime).toBe('high');
      expect(retrieved!.volatility5m).toBe(0.0025);
      expect(retrieved!.windowOpenPrice).toBe(3500);
    });

    it('should store features correctly', async () => {
      const features = createTestFeatures({
        stateMinute: 3,
        minutesRemaining: 12,
        hourOfDay: 10,
        dayOfWeek: 1,
        returnSinceOpen: 0.001,
        maxRunUp: 0.002,
        maxRunDown: -0.0015,
        return1m: 0.0003,
        return3m: 0.0008,
        return5m: 0.0012,
        volatility5m: 0.0018,
        hasUpHit: true,
        hasDownHit: false,
        firstUpHitMinute: 2,
        firstDownHitMinute: NaN,
      });

      const trade = createTestTrade({ features });
      const id = await repository.recordTrade(trade);
      const retrieved = await repository.getTradeById(id);

      expect(retrieved!.features).toBeDefined();
      expect(retrieved!.features.stateMinute).toBe(3);
      expect(retrieved!.features.minutesRemaining).toBe(12);
      expect(retrieved!.features.returnSinceOpen).toBe(0.001);
      expect(retrieved!.features.maxRunUp).toBe(0.002);
      expect(retrieved!.features.maxRunDown).toBe(-0.0015);
      expect(retrieved!.features.hasUpHit).toBe(true);
      expect(retrieved!.features.hasDownHit).toBe(false);
      expect(retrieved!.features.firstUpHitMinute).toBe(2);
      expect(Number.isNaN(retrieved!.features.firstDownHitMinute)).toBe(true);
    });

    it('should handle NaN values in features', async () => {
      const features = createTestFeatures({
        returnSinceOpen: NaN,
        return1m: NaN,
        volatility5m: NaN,
        firstUpHitMinute: NaN,
        firstDownHitMinute: NaN,
      });

      const trade = createTestTrade({ features });
      const id = await repository.recordTrade(trade);
      const retrieved = await repository.getTradeById(id);

      expect(Number.isNaN(retrieved!.features.returnSinceOpen)).toBe(true);
      expect(Number.isNaN(retrieved!.features.return1m)).toBe(true);
      expect(Number.isNaN(retrieved!.features.volatility5m)).toBe(true);
      expect(Number.isNaN(retrieved!.features.firstUpHitMinute)).toBe(true);
      expect(Number.isNaN(retrieved!.features.firstDownHitMinute)).toBe(true);
    });

    it('should reject duplicate condition IDs', async () => {
      const trade = createTestTrade({ conditionId: 'duplicate-cond' });

      await repository.recordTrade(trade);

      await expect(repository.recordTrade(trade)).rejects.toThrow();
    });
  });

  describe('updateOutcome', () => {
    it('should update outcome fields correctly', async () => {
      const trade = createTestTrade();
      await repository.recordTrade(trade);

      const outcome = createTestOutcome({
        outcome: 'UP',
        isWin: true,
        pnl: 50.0,
        timeToUpThreshold: 3,
        maxFavorableExcursion: 0.005,
        maxAdverseExcursion: -0.002,
      });

      await repository.updateOutcome(trade.conditionId, outcome);

      const retrieved = await repository.getTradeByConditionId(trade.conditionId);

      expect(retrieved!.outcome).toBe('UP');
      expect(retrieved!.isWin).toBe(true);
      expect(retrieved!.pnl).toBe(50.0);
      expect(retrieved!.timeToUpThreshold).toBe(3);
      expect(retrieved!.maxFavorableExcursion).toBe(0.005);
      expect(retrieved!.maxAdverseExcursion).toBe(-0.002);
      expect(retrieved!.updatedAt).toBeDefined();
    });

    it('should handle losing trades', async () => {
      const trade = createTestTrade({ side: 'YES' });
      await repository.recordTrade(trade);

      const outcome = createTestOutcome({
        outcome: 'DOWN',
        isWin: false,
        pnl: -65.0,
      });

      await repository.updateOutcome(trade.conditionId, outcome);

      const retrieved = await repository.getTradeByConditionId(trade.conditionId);

      expect(retrieved!.outcome).toBe('DOWN');
      expect(retrieved!.isWin).toBe(false);
      expect(retrieved!.pnl).toBe(-65.0);
    });
  });

  describe('recordMinutePrice', () => {
    it('should store minute prices correctly', async () => {
      const trade = createTestTrade();
      const tradeId = await repository.recordTrade(trade);

      // Record prices for minutes 0-4
      for (let minute = 0; minute < 5; minute++) {
        await repository.recordMinutePrice(
          tradeId,
          minute,
          50000 + minute * 10,
          Date.now() + minute * 60000
        );
      }

      const retrieved = await repository.getTradeById(tradeId);

      expect(retrieved!.minutePrices).toHaveLength(5);
      expect(retrieved!.minutePrices![0].minuteOffset).toBe(0);
      expect(retrieved!.minutePrices![0].price).toBe(50000);
      expect(retrieved!.minutePrices![4].minuteOffset).toBe(4);
      expect(retrieved!.minutePrices![4].price).toBe(50040);
    });

    it('should update existing minute price on conflict', async () => {
      const trade = createTestTrade();
      const tradeId = await repository.recordTrade(trade);

      await repository.recordMinutePrice(tradeId, 0, 50000, Date.now());
      await repository.recordMinutePrice(tradeId, 0, 50100, Date.now()); // Update same minute

      const retrieved = await repository.getTradeById(tradeId);

      expect(retrieved!.minutePrices).toHaveLength(1);
      expect(retrieved!.minutePrices![0].price).toBe(50100);
    });
  });

  // ============================================================================
  // Read Operation Tests
  // ============================================================================

  describe('getTradeByConditionId', () => {
    it('should return trade by condition ID', async () => {
      const trade = createTestTrade({ conditionId: 'find-me-cond' });
      await repository.recordTrade(trade);

      const retrieved = await repository.getTradeByConditionId('find-me-cond');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.conditionId).toBe('find-me-cond');
    });

    it('should return null for non-existent condition ID', async () => {
      const retrieved = await repository.getTradeByConditionId('non-existent');

      expect(retrieved).toBeNull();
    });
  });

  describe('getTradeById', () => {
    it('should return trade by database ID', async () => {
      const trade = createTestTrade();
      const id = await repository.recordTrade(trade);

      const retrieved = await repository.getTradeById(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(id);
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await repository.getTradeById(99999);

      expect(retrieved).toBeNull();
    });
  });

  describe('getPendingTrades', () => {
    it('should return only pending trades', async () => {
      // Create 3 trades
      const trade1 = createTestTrade();
      const trade2 = createTestTrade();
      const trade3 = createTestTrade();

      await repository.recordTrade(trade1);
      await repository.recordTrade(trade2);
      await repository.recordTrade(trade3);

      // Resolve trade2
      await repository.updateOutcome(trade2.conditionId, createTestOutcome());

      const pending = await repository.getPendingTrades();

      expect(pending).toHaveLength(2);
      expect(pending.every((t) => t.outcome == null)).toBe(true);
    });

    it('should return empty array when no pending trades', async () => {
      const trade = createTestTrade();
      await repository.recordTrade(trade);
      await repository.updateOutcome(trade.conditionId, createTestOutcome());

      const pending = await repository.getPendingTrades();

      expect(pending).toHaveLength(0);
    });

    it('should respect limit parameter', async () => {
      // Create 5 trades
      for (let i = 0; i < 5; i++) {
        await repository.recordTrade(createTestTrade());
      }

      const pending = await repository.getPendingTrades(2);

      expect(pending).toHaveLength(2);
    });
  });

  // ============================================================================
  // Analysis Query Tests
  // ============================================================================

  describe('getTradesByDateRange', () => {
    it('should return trades within date range', async () => {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      // Create trades at different times
      await repository.recordTrade(
        createTestTrade({ signalTimestamp: now - 2 * oneDay })
      );
      await repository.recordTrade(
        createTestTrade({ signalTimestamp: now - oneDay })
      );
      await repository.recordTrade(
        createTestTrade({ signalTimestamp: now })
      );

      const start = new Date(now - 1.5 * oneDay);
      const end = new Date(now + oneDay);

      const trades = await repository.getTradesByDateRange(start, end);

      expect(trades).toHaveLength(2);
    });
  });

  describe('getTradesBySymbol', () => {
    it('should return trades for specific symbol', async () => {
      await repository.recordTrade(createTestTrade({ symbol: 'BTC' as CryptoAsset }));
      await repository.recordTrade(createTestTrade({ symbol: 'ETH' as CryptoAsset }));
      await repository.recordTrade(createTestTrade({ symbol: 'BTC' as CryptoAsset }));

      const btcTrades = await repository.getTradesBySymbol('BTC');

      expect(btcTrades).toHaveLength(2);
      expect(btcTrades.every((t) => t.symbol === 'BTC')).toBe(true);
    });
  });

  describe('getPerformanceByRegime', () => {
    it('should calculate regime statistics correctly', async () => {
      // Create trades with 'mid' volatility regime
      for (let i = 0; i < 5; i++) {
        const trade = createTestTrade({ volatilityRegime: 'mid' });
        await repository.recordTrade(trade);

        // Resolve with alternating wins/losses
        await repository.updateOutcome(
          trade.conditionId,
          createTestOutcome({
            isWin: i % 2 === 0,
            pnl: i % 2 === 0 ? 50 : -65,
          })
        );
      }

      const stats = await repository.getPerformanceByRegime('mid');

      expect(stats.regime).toBe('mid');
      expect(stats.totalTrades).toBe(5);
      expect(stats.wins).toBe(3); // 0, 2, 4 are wins
      expect(stats.winRate).toBeCloseTo(60, 0);
      expect(stats.totalPnl).toBe(3 * 50 - 2 * 65); // 150 - 130 = 20
    });
  });

  describe('getCalibrationData', () => {
    it('should group trades by probability buckets', async () => {
      // Create trades with different probabilities
      const probabilities = [0.75, 0.72, 0.65, 0.55, 0.45];

      for (const prob of probabilities) {
        const trade = createTestTrade({ probability: prob, side: 'YES' });
        await repository.recordTrade(trade);
        await repository.updateOutcome(
          trade.conditionId,
          createTestOutcome({ isWin: prob > 0.6 })
        );
      }

      const calibration = await repository.getCalibrationData();

      expect(calibration.length).toBeGreaterThan(0);
      expect(calibration.some((b) => b.bucket === '0.75+')).toBe(true);
    });
  });

  describe('getSymbolStats', () => {
    it('should calculate symbol statistics correctly', async () => {
      // Create trades for BTC with different outcomes
      for (let i = 0; i < 4; i++) {
        const trade = createTestTrade({ symbol: 'BTC' as CryptoAsset });
        await repository.recordTrade(trade);
        await repository.updateOutcome(
          trade.conditionId,
          createTestOutcome({
            isWin: i < 3, // 3 wins, 1 loss
            pnl: i < 3 ? 50 : -65,
          })
        );
      }

      const stats = await repository.getSymbolStats('BTC');

      expect(stats.symbol).toBe('BTC');
      expect(stats.totalTrades).toBe(4);
      expect(stats.wins).toBe(3);
      expect(stats.winRate).toBeCloseTo(75, 0);
      expect(stats.totalPnl).toBe(3 * 50 - 65); // 150 - 65 = 85
      expect(stats.avgPnl).toBeCloseTo(85 / 4, 1);
    });

    it('should return zeros for symbol with no resolved trades', async () => {
      // Create an unresolved trade for ETH
      const trade = createTestTrade({ symbol: 'ETH' as CryptoAsset });
      await repository.recordTrade(trade);

      const stats = await repository.getSymbolStats('ETH');

      expect(stats.symbol).toBe('ETH');
      expect(stats.totalTrades).toBe(0);
      expect(stats.wins).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.totalPnl).toBe(0);
    });
  });

  describe('getAllSymbolStats', () => {
    it('should return statistics for all symbols with trades', async () => {
      // Create resolved trades for different symbols
      const symbols: CryptoAsset[] = ['BTC', 'ETH', 'SOL'];

      for (const symbol of symbols) {
        const trade = createTestTrade({ symbol });
        await repository.recordTrade(trade);
        await repository.updateOutcome(
          trade.conditionId,
          createTestOutcome({ isWin: true, pnl: 50 })
        );
      }

      const allStats = await repository.getAllSymbolStats();

      expect(allStats).toHaveLength(3);
      expect(allStats.every((s) => s.totalTrades === 1)).toBe(true);
      expect(allStats.every((s) => s.wins === 1)).toBe(true);
    });

    it('should exclude symbols with only unresolved trades', async () => {
      // Create resolved trade for BTC
      const btcTrade = createTestTrade({ symbol: 'BTC' as CryptoAsset });
      await repository.recordTrade(btcTrade);
      await repository.updateOutcome(btcTrade.conditionId, createTestOutcome());

      // Create unresolved trade for ETH
      const ethTrade = createTestTrade({ symbol: 'ETH' as CryptoAsset });
      await repository.recordTrade(ethTrade);

      const allStats = await repository.getAllSymbolStats();

      expect(allStats).toHaveLength(1);
      expect(allStats[0].symbol).toBe('BTC');
    });
  });

  describe('getAllRegimeStats', () => {
    it('should return statistics for all volatility regimes', async () => {
      // Create resolved trades for each regime
      const regimes: Array<'low' | 'mid' | 'high'> = ['low', 'mid', 'high'];

      for (const regime of regimes) {
        const trade = createTestTrade({ volatilityRegime: regime });
        await repository.recordTrade(trade);
        await repository.updateOutcome(
          trade.conditionId,
          createTestOutcome({ isWin: regime === 'mid', pnl: regime === 'mid' ? 50 : -30 })
        );
      }

      const allStats = await repository.getAllRegimeStats();

      expect(allStats).toHaveLength(3);
      expect(allStats.some((s) => s.regime === 'low')).toBe(true);
      expect(allStats.some((s) => s.regime === 'mid')).toBe(true);
      expect(allStats.some((s) => s.regime === 'high')).toBe(true);

      const midStats = allStats.find((s) => s.regime === 'mid');
      expect(midStats?.wins).toBe(1);
      expect(midStats?.totalPnl).toBe(50);
    });

    it('should exclude trades without volatility regime', async () => {
      // Create trade without regime
      const tradeNoRegime = createTestTrade({ volatilityRegime: undefined });
      await repository.recordTrade(tradeNoRegime);
      await repository.updateOutcome(tradeNoRegime.conditionId, createTestOutcome());

      // Create trade with regime
      const tradeWithRegime = createTestTrade({ volatilityRegime: 'high' });
      await repository.recordTrade(tradeWithRegime);
      await repository.updateOutcome(tradeWithRegime.conditionId, createTestOutcome());

      const allStats = await repository.getAllRegimeStats();

      expect(allStats).toHaveLength(1);
      expect(allStats[0].regime).toBe('high');
    });
  });

  // ============================================================================
  // Maintenance Tests
  // ============================================================================

  describe('getStats', () => {
    it('should return correct database statistics', async () => {
      const trade1 = createTestTrade();
      const trade2 = createTestTrade();
      const trade3 = createTestTrade();

      await repository.recordTrade(trade1);
      await repository.recordTrade(trade2);
      await repository.recordTrade(trade3);

      await repository.updateOutcome(trade2.conditionId, createTestOutcome());

      const stats = await repository.getStats();

      expect(stats.totalTrades).toBe(3);
      expect(stats.pendingTrades).toBe(2);
      expect(stats.resolvedTrades).toBe(1);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
      expect(stats.oldestTrade).toBeDefined();
      expect(stats.newestTrade).toBeDefined();
    });
  });

  describe('vacuum', () => {
    it('should execute VACUUM without error', async () => {
      // Add and remove some data to create fragmentation
      const trade = createTestTrade();
      await repository.recordTrade(trade);

      await expect(repository.vacuum()).resolves.toBeUndefined();
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty string values', async () => {
      const trade = createTestTrade({
        slug: '',
      });

      const id = await repository.recordTrade(trade);
      const retrieved = await repository.getTradeById(id);

      expect(retrieved!.slug).toBe('');
    });

    it('should handle zero values', async () => {
      const trade = createTestTrade({
        positionSize: 0,
        probability: 0,
        linearCombination: 0,
        imputedCount: 0,
      });

      const id = await repository.recordTrade(trade);
      const retrieved = await repository.getTradeById(id);

      expect(retrieved!.positionSize).toBe(0);
      expect(retrieved!.probability).toBe(0);
      expect(retrieved!.linearCombination).toBe(0);
      expect(retrieved!.imputedCount).toBe(0);
    });

    it('should handle all assets', async () => {
      const assets: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

      for (const asset of assets) {
        const trade = createTestTrade({ symbol: asset });
        const id = await repository.recordTrade(trade);
        const retrieved = await repository.getTradeById(id);

        expect(retrieved!.symbol).toBe(asset);
      }
    });

    it('should handle all volatility regimes', async () => {
      const regimes: Array<'low' | 'mid' | 'high'> = ['low', 'mid', 'high'];

      for (const regime of regimes) {
        const trade = createTestTrade({ volatilityRegime: regime });
        const id = await repository.recordTrade(trade);
        const retrieved = await repository.getTradeById(id);

        expect(retrieved!.volatilityRegime).toBe(regime);
      }
    });

    it('should handle both trade sides', async () => {
      const sides: Array<'YES' | 'NO'> = ['YES', 'NO'];

      for (const side of sides) {
        const trade = createTestTrade({ side });
        const id = await repository.recordTrade(trade);
        const retrieved = await repository.getTradeById(id);

        expect(retrieved!.side).toBe(side);
      }
    });
  });

  // ============================================================================
  // Batch Query Tests (N+1 fix verification)
  // ============================================================================

  describe('batch queries', () => {
    it('should efficiently fetch multiple trades with getPendingTrades', async () => {
      // Create multiple trades
      for (let i = 0; i < 10; i++) {
        await repository.recordTrade(createTestTrade());
      }

      // This should use batch queries internally
      const trades = await repository.getPendingTrades();

      expect(trades).toHaveLength(10);
      // All trades should have features
      expect(trades.every((t) => t.features !== null)).toBe(true);
    });

    it('should efficiently fetch multiple trades with getTradesBySymbol', async () => {
      // Create trades for different symbols
      for (let i = 0; i < 5; i++) {
        await repository.recordTrade(createTestTrade({ symbol: 'BTC' as CryptoAsset }));
        await repository.recordTrade(createTestTrade({ symbol: 'ETH' as CryptoAsset }));
      }

      const btcTrades = await repository.getTradesBySymbol('BTC');

      expect(btcTrades).toHaveLength(5);
      expect(btcTrades.every((t) => t.features !== null)).toBe(true);
    });
  });

  // ============================================================================
  // Evaluation Record Tests (Part of #36)
  // ============================================================================

  describe('recordEvaluation', () => {
    it('should insert an evaluation and return an ID', async () => {
      const evaluation = createTestEvaluation();
      const id = await repository.recordEvaluation(evaluation);

      expect(id).toBeGreaterThan(0);
    });

    it('should store all evaluation fields correctly', async () => {
      const evaluation = createTestEvaluation({
        conditionId: 'eval-cond-123',
        slug: 'eth-updown-15m',
        symbol: 'ETH' as CryptoAsset,
        timestamp: 1700000000000,
        stateMinute: 7,
        modelProbability: 0.68,
        linearCombination: 0.75,
        imputedCount: 2,
        marketPriceYes: 0.62,
        marketPriceNo: 0.38,
        decision: 'NO',
        reason: 'Price below threshold',
      });

      const id = await repository.recordEvaluation(evaluation);
      const retrieved = await repository.getEvaluationById(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.conditionId).toBe('eval-cond-123');
      expect(retrieved!.slug).toBe('eth-updown-15m');
      expect(retrieved!.symbol).toBe('ETH');
      expect(retrieved!.timestamp).toBe(1700000000000);
      expect(retrieved!.stateMinute).toBe(7);
      expect(retrieved!.modelProbability).toBeCloseTo(0.68, 2);
      expect(retrieved!.linearCombination).toBeCloseTo(0.75, 2);
      expect(retrieved!.imputedCount).toBe(2);
      expect(retrieved!.marketPriceYes).toBeCloseTo(0.62, 2);
      expect(retrieved!.marketPriceNo).toBeCloseTo(0.38, 2);
      expect(retrieved!.decision).toBe('NO');
      expect(retrieved!.reason).toBe('Price below threshold');
    });

    it('should handle SKIP decisions', async () => {
      const evaluation = createTestEvaluation({
        decision: 'SKIP',
        reason: 'No edge detected',
      });

      const id = await repository.recordEvaluation(evaluation);
      const retrieved = await repository.getEvaluationById(id);

      expect(retrieved!.decision).toBe('SKIP');
      expect(retrieved!.reason).toBe('No edge detected');
    });

    it('should store features JSON correctly', async () => {
      const features = {
        stateMinute: 3,
        volatility5m: 0.015,
        returnSinceOpen: 0.002,
      };
      const evaluation = createTestEvaluation({
        featuresJson: JSON.stringify(features),
      });

      const id = await repository.recordEvaluation(evaluation);
      const retrieved = await repository.getEvaluationById(id);

      const parsedFeatures = JSON.parse(retrieved!.featuresJson);
      expect(parsedFeatures.stateMinute).toBe(3);
      expect(parsedFeatures.volatility5m).toBeCloseTo(0.015, 3);
      expect(parsedFeatures.returnSinceOpen).toBeCloseTo(0.002, 3);
    });
  });

  describe('recordEvaluations (batch)', () => {
    it('should insert multiple evaluations efficiently', async () => {
      const evaluations = [
        createTestEvaluation({ decision: 'YES' }),
        createTestEvaluation({ decision: 'NO' }),
        createTestEvaluation({ decision: 'SKIP' }),
      ];

      const ids = await repository.recordEvaluations(evaluations);

      expect(ids).toHaveLength(3);
      expect(ids.every((id) => id > 0)).toBe(true);
      expect(ids[0]).toBeLessThan(ids[1]);
      expect(ids[1]).toBeLessThan(ids[2]);
    });

    it('should handle empty array', async () => {
      const ids = await repository.recordEvaluations([]);

      expect(ids).toEqual([]);
    });

    it('should be atomic - all or nothing on error', async () => {
      // This test verifies transaction rollback on failure
      const initialEvalId = await repository.recordEvaluation(createTestEvaluation());
      expect(initialEvalId).toBeGreaterThan(0);

      const evaluationsWithFailure = [
        createTestEvaluation({ conditionId: 'atomic-test-1' }),
        // This record is invalid because `slug` is NOT NULL in the database schema.
        { ...createTestEvaluation({ conditionId: 'atomic-test-2' }), slug: null } as unknown as EvaluationRecord,
      ];

      // This batch insert should fail and roll back the transaction.
      await expect(repository.recordEvaluations(evaluationsWithFailure)).rejects.toThrow();

      // Insert another valid evaluation to check the auto-incrementing ID.
      const finalEvalId = await repository.recordEvaluation(createTestEvaluation());

      // If the transaction was atomic, the failed batch should not have consumed an ID.
      // The new ID should be the next sequential one after the initial insert.
      expect(finalEvalId).toBe(initialEvalId + 1);
    });

    it('should handle all crypto assets', async () => {
      const assets: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];
      const evaluations = assets.map((symbol) =>
        createTestEvaluation({ symbol })
      );

      const ids = await repository.recordEvaluations(evaluations);

      expect(ids).toHaveLength(4);

      for (let i = 0; i < assets.length; i++) {
        const retrieved = await repository.getEvaluationById(ids[i]);
        expect(retrieved!.symbol).toBe(assets[i]);
      }
    });
  });

  describe('getEvaluationById', () => {
    it('should return null for non-existent evaluation', async () => {
      const result = await repository.getEvaluationById(99999);

      expect(result).toBeNull();
    });

    it('should return correct evaluation', async () => {
      const evaluation = createTestEvaluation();
      const id = await repository.recordEvaluation(evaluation);

      const retrieved = await repository.getEvaluationById(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(id);
      expect(retrieved!.conditionId).toBe(evaluation.conditionId);
    });
  });

  // ============================================================================
  // Evaluation Analytics Tests (Part of #38)
  // ============================================================================

  describe('getEvaluationsByDateRange', () => {
    it('should return evaluations within the date range', async () => {
      // Create evaluations at different times
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP + ONE_MINUTE_MS }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP + TWO_MINUTES_MS }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 90000);

      const results = await repository.getEvaluationsByDateRange(start, end);

      expect(results).toHaveLength(2);
      expect(results[0].timestamp).toBe(TEST_BASE_TIMESTAMP);
      expect(results[1].timestamp).toBe(TEST_BASE_TIMESTAMP + ONE_MINUTE_MS);
    });

    it('should return empty array when no evaluations in range', async () => {
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP }));

      const start = new Date(TEST_BASE_TIMESTAMP + 100000);
      const end = new Date(TEST_BASE_TIMESTAMP + 200000);

      const results = await repository.getEvaluationsByDateRange(start, end);

      expect(results).toHaveLength(0);
    });

    it('should order results by timestamp ascending', async () => {
      // Insert in reverse order
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP + TWO_MINUTES_MS }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP + ONE_MINUTE_MS }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 200000);

      const results = await repository.getEvaluationsByDateRange(start, end);

      expect(results).toHaveLength(3);
      expect(results[0].timestamp).toBe(TEST_BASE_TIMESTAMP);
      expect(results[1].timestamp).toBe(TEST_BASE_TIMESTAMP + ONE_MINUTE_MS);
      expect(results[2].timestamp).toBe(TEST_BASE_TIMESTAMP + TWO_MINUTES_MS);
    });

    it('should support pagination with limit and offset', async () => {
      // Create 5 evaluations
      for (let i = 0; i < 5; i++) {
        await repository.recordEvaluation(createTestEvaluation({
          timestamp: TEST_BASE_TIMESTAMP + i * ONE_MINUTE_MS,
        }));
      }

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 10 * ONE_MINUTE_MS);

      // Get first 2
      const page1 = await repository.getEvaluationsByDateRange(start, end, { limit: 2 });
      expect(page1).toHaveLength(2);
      expect(page1[0].timestamp).toBe(TEST_BASE_TIMESTAMP);
      expect(page1[1].timestamp).toBe(TEST_BASE_TIMESTAMP + ONE_MINUTE_MS);

      // Get next 2
      const page2 = await repository.getEvaluationsByDateRange(start, end, { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      expect(page2[0].timestamp).toBe(TEST_BASE_TIMESTAMP + 2 * ONE_MINUTE_MS);
      expect(page2[1].timestamp).toBe(TEST_BASE_TIMESTAMP + 3 * ONE_MINUTE_MS);

      // Get last 1
      const page3 = await repository.getEvaluationsByDateRange(start, end, { limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
      expect(page3[0].timestamp).toBe(TEST_BASE_TIMESTAMP + 4 * ONE_MINUTE_MS);
    });
  });

  describe('getProbabilityDistribution', () => {
    it('should bucket probabilities correctly with default bucket size', async () => {
      // Create evaluations with different probabilities
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, modelProbability: 0.52, marketPriceYes: 0.50 }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, modelProbability: 0.53, marketPriceYes: 0.52 }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, modelProbability: 0.61, marketPriceYes: 0.60 }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, modelProbability: 0.72, marketPriceYes: 0.70 }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      const results = await repository.getProbabilityDistribution(start, end);

      // Should have 3 buckets: 0.50-0.55, 0.60-0.65, 0.70-0.75
      expect(results.length).toBeGreaterThanOrEqual(3);

      // Check the 0.50-0.55 bucket
      const bucket50 = results.find(r => r.bucket === '0.50-0.55');
      expect(bucket50).toBeDefined();
      expect(bucket50!.count).toBe(2);
      expect(bucket50!.avgMarketPrice).toBeCloseTo(0.51, 2);
    });

    it('should work with custom bucket sizes', async () => {
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, modelProbability: 0.52 }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, modelProbability: 0.58 }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, modelProbability: 0.72 }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      const results = await repository.getProbabilityDistribution(start, end, 0.10);

      // With 0.10 bucket size: 0.50-0.60 (2), 0.70-0.80 (1)
      expect(results).toHaveLength(2);

      const bucket50 = results.find(r => r.bucket === '0.50-0.60');
      expect(bucket50).toBeDefined();
      expect(bucket50!.count).toBe(2);
    });

    it('should throw error for invalid bucket size', async () => {
      const start = new Date();
      const end = new Date();

      await expect(repository.getProbabilityDistribution(start, end, 0)).rejects.toThrow();
      await expect(repository.getProbabilityDistribution(start, end, -0.1)).rejects.toThrow();
      await expect(repository.getProbabilityDistribution(start, end, 1.5)).rejects.toThrow();
    });

    it('should return empty array when no evaluations in range', async () => {
      const start = new Date(TEST_BASE_TIMESTAMP);
      const end = new Date(TEST_BASE_TIMESTAMP + 60 * ONE_MINUTE_MS);

      const results = await repository.getProbabilityDistribution(start, end);

      expect(results).toHaveLength(0);
    });
  });

  describe('getDecisionBreakdown', () => {
    it('should count decisions by symbol', async () => {
      // BTC: 2 SKIP, 1 YES, 1 NO
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, symbol: 'BTC' as CryptoAsset, decision: 'SKIP', modelProbability: 0.50 }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, symbol: 'BTC' as CryptoAsset, decision: 'SKIP', modelProbability: 0.52 }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, symbol: 'BTC' as CryptoAsset, decision: 'YES' }));
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, symbol: 'BTC' as CryptoAsset, decision: 'NO' }));

      // ETH: 1 YES
      await repository.recordEvaluation(createTestEvaluation({ timestamp: TEST_BASE_TIMESTAMP, symbol: 'ETH' as CryptoAsset, decision: 'YES' }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      const results = await repository.getDecisionBreakdown(start, end);

      expect(results).toHaveLength(2);

      const btcStats = results.find(r => r.symbol === 'BTC');
      expect(btcStats).toBeDefined();
      expect(btcStats!.skipCount).toBe(2);
      expect(btcStats!.yesCount).toBe(1);
      expect(btcStats!.noCount).toBe(1);
      expect(btcStats!.avgSkipProb).toBeCloseTo(0.51, 2);

      const ethStats = results.find(r => r.symbol === 'ETH');
      expect(ethStats).toBeDefined();
      expect(ethStats!.skipCount).toBe(0);
      expect(ethStats!.yesCount).toBe(1);
      expect(ethStats!.noCount).toBe(0);
    });

    it('should return empty array when no evaluations in range', async () => {
      const start = new Date(TEST_BASE_TIMESTAMP);
      const end = new Date(TEST_BASE_TIMESTAMP + 60 * ONE_MINUTE_MS);

      const results = await repository.getDecisionBreakdown(start, end);

      expect(results).toHaveLength(0);
    });
  });

  describe('simulateThreshold', () => {
    it('should identify new opportunities with lower thresholds', async () => {
      // Original threshold was 0.70, this was a SKIP at 0.68
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        modelProbability: 0.68,
        decision: 'SKIP',
        reason: 'Below threshold',
      }));

      // This actually traded at 0.75
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        modelProbability: 0.75,
        decision: 'YES',
      }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      // Simulate with lower YES threshold of 0.65
      const result = await repository.simulateThreshold(start, end, 0.65, 0.65);

      expect(result.actuallyTraded).toBe(1);
      expect(result.wouldTrade).toBe(2);
      expect(result.newOpportunities).toHaveLength(1);
      expect(result.newOpportunities[0].modelProbability).toBeCloseTo(0.68, 2);
      expect(result.lostTrades).toHaveLength(0);
    });

    it('should identify lost trades with stricter thresholds', async () => {
      // Traded at 0.72
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        modelProbability: 0.72,
        decision: 'YES',
      }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      // Simulate with stricter threshold of 0.75
      const result = await repository.simulateThreshold(start, end, 0.75, 0.75);

      expect(result.actuallyTraded).toBe(1);
      expect(result.wouldTrade).toBe(0);
      expect(result.newOpportunities).toHaveLength(0);
      expect(result.lostTrades).toHaveLength(1);
      expect(result.lostTrades[0].modelProbability).toBeCloseTo(0.72, 2);
    });

    it('should handle NO trades based on low probability', async () => {
      // Low probability = NO trade
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        modelProbability: 0.28,
        decision: 'NO',
      }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      // noThreshold = 0.70 means we trade NO when prob <= 0.30
      const result = await repository.simulateThreshold(start, end, 0.70, 0.70);

      expect(result.wouldTrade).toBe(1);
      expect(result.actuallyTraded).toBe(1);
    });

    it('should throw error for invalid thresholds', async () => {
      const start = new Date();
      const end = new Date();

      await expect(repository.simulateThreshold(start, end, -0.1, 0.70)).rejects.toThrow();
      await expect(repository.simulateThreshold(start, end, 1.5, 0.70)).rejects.toThrow();
      await expect(repository.simulateThreshold(start, end, 0.70, -0.1)).rejects.toThrow();
      await expect(repository.simulateThreshold(start, end, 0.70, 1.5)).rejects.toThrow();
    });
  });

  describe('getModelVsMarket', () => {
    it('should calculate correlation between model and market', async () => {
      // Create evaluations with positively correlated model and market prices
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'BTC' as CryptoAsset,
        modelProbability: 0.50,
        marketPriceYes: 0.48,
      }));
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'BTC' as CryptoAsset,
        modelProbability: 0.60,
        marketPriceYes: 0.58,
      }));
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'BTC' as CryptoAsset,
        modelProbability: 0.70,
        marketPriceYes: 0.68,
      }));
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'BTC' as CryptoAsset,
        modelProbability: 0.80,
        marketPriceYes: 0.78,
      }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      const results = await repository.getModelVsMarket(start, end);

      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('BTC');
      expect(results[0].avgModelProb).toBeCloseTo(0.65, 2);
      expect(results[0].avgMarketPriceYes).toBeCloseTo(0.63, 2);
      expect(results[0].evaluationCount).toBe(4);
      // Should have high positive correlation
      expect(results[0].correlation).toBeGreaterThan(0.99);
    });

    it('should handle multiple symbols', async () => {
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'BTC' as CryptoAsset,
        modelProbability: 0.60,
        marketPriceYes: 0.55,
      }));
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'BTC' as CryptoAsset,
        modelProbability: 0.70,
        marketPriceYes: 0.65,
      }));
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'ETH' as CryptoAsset,
        modelProbability: 0.55,
        marketPriceYes: 0.50,
      }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      const results = await repository.getModelVsMarket(start, end);

      expect(results).toHaveLength(2);

      const btcStats = results.find(r => r.symbol === 'BTC');
      expect(btcStats).toBeDefined();
      expect(btcStats!.evaluationCount).toBe(2);
      expect(btcStats!.avgModelProb).toBeCloseTo(0.65, 2);

      const ethStats = results.find(r => r.symbol === 'ETH');
      expect(ethStats).toBeDefined();
      expect(ethStats!.evaluationCount).toBe(1);
    });

    it('should return 0 correlation with single data point', async () => {
      await repository.recordEvaluation(createTestEvaluation({
        timestamp: TEST_BASE_TIMESTAMP,
        symbol: 'BTC' as CryptoAsset,
        modelProbability: 0.60,
        marketPriceYes: 0.55,
      }));

      const start = new Date(TEST_BASE_TIMESTAMP - 1000);
      const end = new Date(TEST_BASE_TIMESTAMP + 1000);

      const results = await repository.getModelVsMarket(start, end);

      expect(results).toHaveLength(1);
      expect(results[0].correlation).toBe(0);
    });

    it('should return empty array when no evaluations in range', async () => {
      const start = new Date(TEST_BASE_TIMESTAMP);
      const end = new Date(TEST_BASE_TIMESTAMP + 60 * ONE_MINUTE_MS);

      const results = await repository.getModelVsMarket(start, end);

      expect(results).toHaveLength(0);
    });
  });
});

// ============================================================================
// Async Mode Tests
// ============================================================================

describe('TradeRepository (async mode)', () => {
  let repository: TradeRepository;

  beforeEach(async () => {
    repository = await setupTestRepository('async');
  });

  afterEach(async () => {
    await teardownTestRepository(repository);
  });

  it('should complete writes asynchronously', async () => {
    const trade = createTestTrade();
    const id = await repository.recordTrade(trade);

    expect(id).toBeGreaterThan(0);

    // Wait a bit for async write to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const retrieved = await repository.getTradeById(id);
    expect(retrieved).not.toBeNull();
  });

  it('should process multiple async writes in order', async () => {
    const trades = [
      createTestTrade(),
      createTestTrade(),
      createTestTrade(),
    ];

    const ids = await Promise.all(trades.map((t) => repository.recordTrade(t)));

    // Wait for all writes to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = await repository.getStats();
    expect(stats.totalTrades).toBe(3);
    expect(ids.every((id) => id > 0)).toBe(true);
  });

  it('should flush write queue on close', async () => {
    // Queue multiple writes
    for (let i = 0; i < 10; i++) {
      repository.recordTrade(createTestTrade());
    }

    // Close should wait for all writes to complete
    await repository.close();

    // Reopen to verify
    const verifyRepo = new TradeRepository({
      dbPath: TEST_DB_PATH,
      syncMode: 'sync',
    });
    await verifyRepo.initialize();

    const stats = await verifyRepo.getStats();
    expect(stats.totalTrades).toBe(10);

    await verifyRepo.close();
  });
});
