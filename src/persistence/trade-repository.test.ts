/**
 * TradeRepository Unit Tests
 *
 * Tests for the SQLite persistence layer for Crypto15ML trades.
 *
 * Part of #25
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { dirname } from 'path';
import { TradeRepository } from './trade-repository.js';
import type { TradeRecord, TradeOutcome } from '../types/trade-record.types.js';
import type { FeatureVector, CryptoAsset } from '../strategies/crypto15-feature-engine.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DB_PATH = './test-data/test-trades.db';

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
// Test Suite
// ============================================================================

describe('TradeRepository', () => {
  let repository: TradeRepository;

  beforeEach(async () => {
    // Ensure test directory exists
    const testDir = dirname(TEST_DB_PATH);
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Clean up any existing test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    // Also clean WAL and SHM files
    if (existsSync(`${TEST_DB_PATH}-wal`)) {
      unlinkSync(`${TEST_DB_PATH}-wal`);
    }
    if (existsSync(`${TEST_DB_PATH}-shm`)) {
      unlinkSync(`${TEST_DB_PATH}-shm`);
    }

    repository = new TradeRepository({
      dbPath: TEST_DB_PATH,
      syncMode: 'sync', // Use sync mode for predictable testing
    });

    await repository.initialize();
  });

  afterEach(async () => {
    await repository.close();

    // Clean up test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    if (existsSync(`${TEST_DB_PATH}-wal`)) {
      unlinkSync(`${TEST_DB_PATH}-wal`);
    }
    if (existsSync(`${TEST_DB_PATH}-shm`)) {
      unlinkSync(`${TEST_DB_PATH}-shm`);
    }
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
});

// ============================================================================
// Async Mode Tests
// ============================================================================

describe('TradeRepository (async mode)', () => {
  let repository: TradeRepository;

  beforeEach(async () => {
    // Ensure test directory exists
    const testDir = dirname(TEST_DB_PATH);
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Clean up any existing test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    if (existsSync(`${TEST_DB_PATH}-wal`)) {
      unlinkSync(`${TEST_DB_PATH}-wal`);
    }
    if (existsSync(`${TEST_DB_PATH}-shm`)) {
      unlinkSync(`${TEST_DB_PATH}-shm`);
    }

    repository = new TradeRepository({
      dbPath: TEST_DB_PATH,
      syncMode: 'async', // Use async mode
    });

    await repository.initialize();
  });

  afterEach(async () => {
    await repository.close();

    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    if (existsSync(`${TEST_DB_PATH}-wal`)) {
      unlinkSync(`${TEST_DB_PATH}-wal`);
    }
    if (existsSync(`${TEST_DB_PATH}-shm`)) {
      unlinkSync(`${TEST_DB_PATH}-shm`);
    }
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
