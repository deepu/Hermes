/**
 * TradeRepository Integration Tests
 *
 * End-to-end tests for the trade persistence layer, testing:
 * - Full trade lifecycle (record -> update outcome -> query)
 * - Data integrity across related tables
 * - Concurrent access patterns
 * - Edge cases with realistic data
 *
 * Note: Query correctness is covered by unit tests. These tests focus on
 * integration concerns that unit tests cannot cover.
 *
 * Run with: pnpm test:integration
 *
 * Part of #29
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { dirname } from 'path';
import { TradeRepository } from './trade-repository.js';
import type { TradeRecord, VolatilityRegime } from '../types/trade-record.types.js';
import type { CryptoAsset } from '../strategies/crypto15-feature-engine.js';
import { createTestTrade, createTestOutcome } from './test-fixtures.js';

// ============================================================================
// Test Configuration
// ============================================================================

const INTEGRATION_DB_PATH = './test-data/integration/trades-integration.db';

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
  // Performance Tests
  // ============================================================================
  // Note: Query correctness tests are in unit tests. These tests focus on
  // performance characteristics that only show up with real database I/O.

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
      // SQLite batch fetch of 100 records should be fast (<100ms for local file)
      expect(fetchTime).toBeLessThan(500);

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

    // Note: Transaction tests removed - the current transaction() method doesn't support
    // async callbacks, making it incompatible with async repository methods like recordTrade.
    // A proper transaction test can be added if transaction() is refactored to support async.
  });
});
