/**
 * TradeRepository - SQLite persistence layer for Crypto15ML trades
 *
 * Implements persistent trade recording using better-sqlite3 for
 * synchronous database operations with async write support.
 *
 * Part of #25
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type {
  TradeRecord,
  TradeOutcome,
  MinutePrice,
  ITradeRepository,
  RegimeStats,
  CalibrationBucket,
  DatabaseStats,
  VolatilityRegime,
  PersistenceConfig,
} from '../types/trade-record.types.js';
import type { CryptoAsset, FeatureVector } from '../strategies/crypto15-feature-engine.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, 'migrations');

// ============================================================================
// TradeRepository Implementation
// ============================================================================

export class TradeRepository implements ITradeRepository {
  private db: Database.Database | null = null;
  private config: PersistenceConfig;
  private writeQueue: Array<() => void> = [];
  private isProcessingQueue = false;

  constructor(config: Partial<PersistenceConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      dbPath: config.dbPath ?? './data/crypto15ml/trades.db',
      syncMode: config.syncMode ?? 'async',
      vacuumIntervalHours: config.vacuumIntervalHours ?? 24,
    };
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Initialize the database connection and run migrations
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Ensure directory exists
    const dbDir = dirname(this.config.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Open database connection
    this.db = new Database(this.config.dbPath);

    // Enable foreign keys and WAL mode for better performance
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');

    // Run migrations
    await this.runMigrations();
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    // Process any remaining writes
    await this.flushWriteQueue();

    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Record a new trade with its features
   * @returns The database ID of the inserted trade
   */
  async recordTrade(trade: TradeRecord): Promise<number> {
    this.ensureInitialized();

    const insertTrade = (): number => {
      const stmt = this.db!.prepare(`
        INSERT INTO trades (
          condition_id, slug, symbol, side, entry_price, position_size,
          signal_timestamp, probability, linear_combination, imputed_count,
          state_minute, hour_of_day, day_of_week, volatility_regime,
          volatility_5m, window_open_price, entry_bid_price, entry_ask_price
        ) VALUES (
          @conditionId, @slug, @symbol, @side, @entryPrice, @positionSize,
          @signalTimestamp, @probability, @linearCombination, @imputedCount,
          @stateMinute, @hourOfDay, @dayOfWeek, @volatilityRegime,
          @volatility5m, @windowOpenPrice, @entryBidPrice, @entryAskPrice
        )
      `);

      const result = stmt.run({
        conditionId: trade.conditionId,
        slug: trade.slug,
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        positionSize: trade.positionSize,
        signalTimestamp: trade.signalTimestamp,
        probability: trade.probability,
        linearCombination: trade.linearCombination,
        imputedCount: trade.imputedCount,
        stateMinute: trade.stateMinute,
        hourOfDay: trade.hourOfDay,
        dayOfWeek: trade.dayOfWeek,
        volatilityRegime: trade.volatilityRegime ?? null,
        volatility5m: this.nullifyNaN(trade.volatility5m),
        windowOpenPrice: this.nullifyNaN(trade.windowOpenPrice),
        entryBidPrice: this.nullifyNaN(trade.entryBidPrice),
        entryAskPrice: this.nullifyNaN(trade.entryAskPrice),
      });

      const tradeId = result.lastInsertRowid as number;

      // Insert features
      this.insertFeatures(tradeId, trade.features);

      return tradeId;
    };

    if (this.config.syncMode === 'sync') {
      return insertTrade();
    }

    // Async mode: queue the write and return immediately
    return new Promise((resolve) => {
      this.queueWrite(() => {
        const id = insertTrade();
        resolve(id);
      });
    });
  }

  /**
   * Update trade outcome on resolution
   */
  async updateOutcome(conditionId: string, outcome: TradeOutcome): Promise<void> {
    this.ensureInitialized();

    const update = (): void => {
      const stmt = this.db!.prepare(`
        UPDATE trades SET
          outcome = @outcome,
          is_win = @isWin,
          pnl = @pnl,
          resolution_timestamp = @resolutionTimestamp,
          window_close_price = @windowClosePrice,
          time_to_up_threshold = @timeToUpThreshold,
          time_to_down_threshold = @timeToDownThreshold,
          max_favorable_excursion = @maxFavorableExcursion,
          max_adverse_excursion = @maxAdverseExcursion,
          updated_at = @updatedAt
        WHERE condition_id = @conditionId
      `);

      stmt.run({
        conditionId,
        outcome: outcome.outcome,
        isWin: outcome.isWin ? 1 : 0,
        pnl: outcome.pnl,
        resolutionTimestamp: outcome.resolutionTimestamp,
        windowClosePrice: outcome.windowClosePrice,
        timeToUpThreshold: outcome.timeToUpThreshold ?? null,
        timeToDownThreshold: outcome.timeToDownThreshold ?? null,
        maxFavorableExcursion: outcome.maxFavorableExcursion,
        maxAdverseExcursion: outcome.maxAdverseExcursion,
        updatedAt: Date.now(),
      });
    };

    if (this.config.syncMode === 'sync') {
      update();
      return;
    }

    return new Promise((resolve) => {
      this.queueWrite(() => {
        update();
        resolve();
      });
    });
  }

  /**
   * Record a minute price snapshot
   */
  async recordMinutePrice(
    tradeId: number,
    minute: number,
    price: number,
    timestamp: number
  ): Promise<void> {
    this.ensureInitialized();

    const insert = (): void => {
      const stmt = this.db!.prepare(`
        INSERT OR REPLACE INTO trade_prices (trade_id, minute_offset, timestamp, price)
        VALUES (@tradeId, @minuteOffset, @timestamp, @price)
      `);

      stmt.run({
        tradeId,
        minuteOffset: minute,
        timestamp,
        price,
      });
    };

    if (this.config.syncMode === 'sync') {
      insert();
      return;
    }

    return new Promise((resolve) => {
      this.queueWrite(() => {
        insert();
        resolve();
      });
    });
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Get trade by Polymarket condition ID
   */
  async getTradeByConditionId(conditionId: string): Promise<TradeRecord | null> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT * FROM trades WHERE condition_id = ?
    `);

    const row = stmt.get(conditionId) as TradeRow | undefined;
    if (!row) return null;

    return this.rowToTradeRecord(row);
  }

  /**
   * Get trade by database ID
   */
  async getTradeById(id: number): Promise<TradeRecord | null> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT * FROM trades WHERE id = ?
    `);

    const row = stmt.get(id) as TradeRow | undefined;
    if (!row) return null;

    return this.rowToTradeRecord(row);
  }

  /**
   * Get all trades awaiting resolution
   */
  async getPendingTrades(): Promise<TradeRecord[]> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT * FROM trades WHERE outcome IS NULL ORDER BY signal_timestamp ASC
    `);

    const rows = stmt.all() as TradeRow[];
    return Promise.all(rows.map((row) => this.rowToTradeRecord(row)));
  }

  // ============================================================================
  // Analysis Queries
  // ============================================================================

  /**
   * Get trades within a date range
   */
  async getTradesByDateRange(start: Date, end: Date): Promise<TradeRecord[]> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT * FROM trades
      WHERE signal_timestamp >= ? AND signal_timestamp <= ?
      ORDER BY signal_timestamp ASC
    `);

    const rows = stmt.all(start.getTime(), end.getTime()) as TradeRow[];
    return Promise.all(rows.map((row) => this.rowToTradeRecord(row)));
  }

  /**
   * Get trades for a specific symbol
   */
  async getTradesBySymbol(symbol: CryptoAsset): Promise<TradeRecord[]> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT * FROM trades WHERE symbol = ? ORDER BY signal_timestamp ASC
    `);

    const rows = stmt.all(symbol) as TradeRow[];
    return Promise.all(rows.map((row) => this.rowToTradeRecord(row)));
  }

  /**
   * Get performance statistics by volatility regime
   */
  async getPerformanceByRegime(regime: VolatilityRegime): Promise<RegimeStats> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
        AVG(is_win) as win_rate,
        AVG(pnl) as avg_pnl,
        SUM(pnl) as total_pnl
      FROM trades
      WHERE volatility_regime = ? AND outcome IS NOT NULL
    `);

    const row = stmt.get(regime) as {
      total_trades: number;
      wins: number;
      win_rate: number | null;
      avg_pnl: number | null;
      total_pnl: number | null;
    };

    return {
      regime,
      totalTrades: row.total_trades,
      wins: row.wins ?? 0,
      winRate: (row.win_rate ?? 0) * 100,
      avgPnl: row.avg_pnl ?? 0,
      totalPnl: row.total_pnl ?? 0,
    };
  }

  /**
   * Get calibration data for all probability buckets
   */
  async getCalibrationData(): Promise<CalibrationBucket[]> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT
        CASE
          WHEN probability >= 0.75 THEN '0.75+'
          WHEN probability >= 0.70 THEN '0.70-0.75'
          WHEN probability >= 0.65 THEN '0.65-0.70'
          WHEN probability >= 0.60 THEN '0.60-0.65'
          WHEN probability >= 0.55 THEN '0.55-0.60'
          WHEN probability >= 0.50 THEN '0.50-0.55'
          WHEN probability >= 0.45 THEN '0.45-0.50'
          WHEN probability >= 0.40 THEN '0.40-0.45'
          WHEN probability >= 0.35 THEN '0.35-0.40'
          WHEN probability >= 0.30 THEN '0.30-0.35'
          WHEN probability >= 0.25 THEN '0.25-0.30'
          ELSE '0.25-'
        END as bucket,
        COUNT(*) as trades,
        AVG(probability) as avg_predicted,
        AVG(is_win) as actual_win_rate
      FROM trades
      WHERE outcome IS NOT NULL AND side = 'YES'
      GROUP BY bucket
      ORDER BY avg_predicted DESC
    `);

    const rows = stmt.all() as Array<{
      bucket: string;
      trades: number;
      avg_predicted: number;
      actual_win_rate: number;
    }>;

    return rows.map((row) => {
      const bounds = this.parseBucketBounds(row.bucket);
      return {
        bucket: row.bucket,
        lowerBound: bounds.lower,
        upperBound: bounds.upper,
        trades: row.trades,
        avgPredicted: row.avg_predicted,
        actualWinRate: row.actual_win_rate,
        calibrationGap: row.actual_win_rate - row.avg_predicted,
      };
    });
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * Run VACUUM to reclaim space
   */
  async vacuum(): Promise<void> {
    this.ensureInitialized();
    this.db!.exec('VACUUM');
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<DatabaseStats> {
    this.ensureInitialized();

    const countStmt = this.db!.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved,
        MIN(signal_timestamp) as oldest,
        MAX(signal_timestamp) as newest
      FROM trades
    `);

    const row = countStmt.get() as {
      total: number;
      pending: number;
      resolved: number;
      oldest: number | null;
      newest: number | null;
    };

    // Get database file size
    let dbSizeBytes = 0;
    if (existsSync(this.config.dbPath)) {
      dbSizeBytes = statSync(this.config.dbPath).size;
    }

    return {
      totalTrades: row.total,
      pendingTrades: row.pending ?? 0,
      resolvedTrades: row.resolved ?? 0,
      dbSizeBytes,
      oldestTrade: row.oldest ?? undefined,
      newestTrade: row.newest ?? undefined,
    };
  }

  // ============================================================================
  // Migration Support
  // ============================================================================

  /**
   * Run pending migrations
   */
  private async runMigrations(): Promise<void> {
    // Get current schema version
    let currentVersion = 0;
    try {
      const versionStmt = this.db!.prepare(
        'SELECT MAX(version) as version FROM schema_version'
      );
      const row = versionStmt.get() as { version: number | null } | undefined;
      currentVersion = row?.version ?? 0;
    } catch {
      // Table doesn't exist yet, version is 0
    }

    // Load and run migrations
    const migrationFiles = this.getMigrationFiles();

    for (const file of migrationFiles) {
      const version = this.extractMigrationVersion(file);
      if (version > currentVersion) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
        this.db!.exec(sql);
      }
    }
  }

  /**
   * Get sorted list of migration files
   */
  private getMigrationFiles(): string[] {
    const { readdirSync } = require('fs');
    try {
      const files = readdirSync(MIGRATIONS_DIR) as string[];
      return files
        .filter((f: string) => f.endsWith('.sql'))
        .sort((a: string, b: string) => {
          const versionA = this.extractMigrationVersion(a);
          const versionB = this.extractMigrationVersion(b);
          return versionA - versionB;
        });
    } catch {
      return [];
    }
  }

  /**
   * Extract version number from migration filename
   */
  private extractMigrationVersion(filename: string): number {
    const match = filename.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Ensure database is initialized
   */
  private ensureInitialized(): void {
    if (!this.db) {
      throw new Error('TradeRepository not initialized. Call initialize() first.');
    }
  }

  /**
   * Convert NaN to null for SQLite storage
   */
  private nullifyNaN(value: number | undefined): number | null {
    if (value === undefined || Number.isNaN(value)) {
      return null;
    }
    return value;
  }

  /**
   * Insert feature vector for a trade
   */
  private insertFeatures(tradeId: number, features: FeatureVector): void {
    const stmt = this.db!.prepare(`
      INSERT INTO trade_features (
        trade_id, state_minute, minutes_remaining, hour_of_day, day_of_week,
        return_since_open, max_run_up, max_run_down, return_1m, return_3m,
        return_5m, volatility_5m, has_up_hit, has_down_hit,
        first_up_hit_minute, first_down_hit_minute
      ) VALUES (
        @tradeId, @stateMinute, @minutesRemaining, @hourOfDay, @dayOfWeek,
        @returnSinceOpen, @maxRunUp, @maxRunDown, @return1m, @return3m,
        @return5m, @volatility5m, @hasUpHit, @hasDownHit,
        @firstUpHitMinute, @firstDownHitMinute
      )
    `);

    stmt.run({
      tradeId,
      stateMinute: features.stateMinute,
      minutesRemaining: features.minutesRemaining,
      hourOfDay: features.hourOfDay,
      dayOfWeek: features.dayOfWeek,
      returnSinceOpen: this.nullifyNaN(features.returnSinceOpen),
      maxRunUp: this.nullifyNaN(features.maxRunUp),
      maxRunDown: this.nullifyNaN(features.maxRunDown),
      return1m: this.nullifyNaN(features.return1m),
      return3m: this.nullifyNaN(features.return3m),
      return5m: this.nullifyNaN(features.return5m),
      volatility5m: this.nullifyNaN(features.volatility5m),
      hasUpHit: features.hasUpHit ? 1 : 0,
      hasDownHit: features.hasDownHit ? 1 : 0,
      firstUpHitMinute: this.nullifyNaN(features.firstUpHitMinute),
      firstDownHitMinute: this.nullifyNaN(features.firstDownHitMinute),
    });
  }

  /**
   * Get features for a trade
   */
  private getFeatures(tradeId: number): FeatureVector | null {
    const stmt = this.db!.prepare(`
      SELECT * FROM trade_features WHERE trade_id = ?
    `);

    const row = stmt.get(tradeId) as FeatureRow | undefined;
    if (!row) return null;

    return {
      stateMinute: row.state_minute,
      minutesRemaining: row.minutes_remaining,
      hourOfDay: row.hour_of_day,
      dayOfWeek: row.day_of_week,
      returnSinceOpen: row.return_since_open ?? NaN,
      maxRunUp: row.max_run_up ?? NaN,
      maxRunDown: row.max_run_down ?? NaN,
      return1m: row.return_1m ?? NaN,
      return3m: row.return_3m ?? NaN,
      return5m: row.return_5m ?? NaN,
      volatility5m: row.volatility_5m ?? NaN,
      hasUpHit: row.has_up_hit === 1,
      hasDownHit: row.has_down_hit === 1,
      firstUpHitMinute: row.first_up_hit_minute ?? NaN,
      firstDownHitMinute: row.first_down_hit_minute ?? NaN,
      asset: 'BTC' as CryptoAsset, // Will be overwritten from trade row
      timestamp: 0, // Will be overwritten from trade row
    };
  }

  /**
   * Get minute prices for a trade
   */
  private getMinutePrices(tradeId: number): MinutePrice[] {
    const stmt = this.db!.prepare(`
      SELECT * FROM trade_prices WHERE trade_id = ? ORDER BY minute_offset ASC
    `);

    const rows = stmt.all(tradeId) as PriceRow[];
    return rows.map((row) => ({
      minuteOffset: row.minute_offset,
      timestamp: row.timestamp,
      price: row.price,
    }));
  }

  /**
   * Convert database row to TradeRecord
   */
  private async rowToTradeRecord(row: TradeRow): Promise<TradeRecord> {
    const features = this.getFeatures(row.id);
    const minutePrices = this.getMinutePrices(row.id);

    // Update feature metadata from trade row
    if (features) {
      features.asset = row.symbol as CryptoAsset;
      features.timestamp = row.signal_timestamp;
    }

    return {
      id: row.id,
      conditionId: row.condition_id,
      slug: row.slug,
      symbol: row.symbol as CryptoAsset,
      side: row.side as 'YES' | 'NO',
      entryPrice: row.entry_price,
      positionSize: row.position_size,
      signalTimestamp: row.signal_timestamp,
      probability: row.probability,
      linearCombination: row.linear_combination,
      imputedCount: row.imputed_count,
      features: features!,
      outcome: row.outcome as 'UP' | 'DOWN' | undefined,
      isWin: row.is_win === null ? undefined : row.is_win === 1,
      pnl: row.pnl ?? undefined,
      resolutionTimestamp: row.resolution_timestamp ?? undefined,
      stateMinute: row.state_minute,
      hourOfDay: row.hour_of_day,
      dayOfWeek: row.day_of_week,
      volatilityRegime: row.volatility_regime as VolatilityRegime | undefined,
      volatility5m: row.volatility_5m ?? undefined,
      timeToUpThreshold: row.time_to_up_threshold ?? undefined,
      timeToDownThreshold: row.time_to_down_threshold ?? undefined,
      maxFavorableExcursion: row.max_favorable_excursion ?? undefined,
      maxAdverseExcursion: row.max_adverse_excursion ?? undefined,
      windowOpenPrice: row.window_open_price ?? undefined,
      windowClosePrice: row.window_close_price ?? undefined,
      entryBidPrice: row.entry_bid_price ?? undefined,
      entryAskPrice: row.entry_ask_price ?? undefined,
      minutePrices,
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  /**
   * Parse bucket bounds from bucket label
   */
  private parseBucketBounds(bucket: string): { lower: number; upper: number } {
    if (bucket === '0.75+') {
      return { lower: 0.75, upper: 1.0 };
    }
    if (bucket === '0.25-') {
      return { lower: 0.0, upper: 0.25 };
    }

    const match = bucket.match(/^([\d.]+)-([\d.]+)$/);
    if (match) {
      return {
        lower: parseFloat(match[1]),
        upper: parseFloat(match[2]),
      };
    }

    return { lower: 0, upper: 0 };
  }

  /**
   * Queue a write operation for async processing
   */
  private queueWrite(operation: () => void): void {
    this.writeQueue.push(operation);
    this.processWriteQueue();
  }

  /**
   * Process queued write operations
   */
  private processWriteQueue(): void {
    if (this.isProcessingQueue || this.writeQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    setImmediate(() => {
      const operation = this.writeQueue.shift();
      if (operation) {
        try {
          operation();
        } catch (error) {
          console.error('TradeRepository write error:', error);
        }
      }
      this.isProcessingQueue = false;

      // Continue processing if more items in queue
      if (this.writeQueue.length > 0) {
        this.processWriteQueue();
      }
    });
  }

  /**
   * Flush all pending write operations
   */
  private async flushWriteQueue(): Promise<void> {
    while (this.writeQueue.length > 0 || this.isProcessingQueue) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

// ============================================================================
// Internal Row Types
// ============================================================================

interface TradeRow {
  id: number;
  condition_id: string;
  slug: string;
  symbol: string;
  side: string;
  entry_price: number;
  position_size: number;
  signal_timestamp: number;
  probability: number;
  linear_combination: number;
  imputed_count: number;
  outcome: string | null;
  is_win: number | null;
  pnl: number | null;
  resolution_timestamp: number | null;
  state_minute: number;
  hour_of_day: number;
  day_of_week: number;
  volatility_regime: string | null;
  volatility_5m: number | null;
  time_to_up_threshold: number | null;
  time_to_down_threshold: number | null;
  max_favorable_excursion: number | null;
  max_adverse_excursion: number | null;
  window_open_price: number | null;
  window_close_price: number | null;
  entry_bid_price: number | null;
  entry_ask_price: number | null;
  created_at: number | null;
  updated_at: number | null;
}

interface FeatureRow {
  id: number;
  trade_id: number;
  state_minute: number;
  minutes_remaining: number;
  hour_of_day: number;
  day_of_week: number;
  return_since_open: number | null;
  max_run_up: number | null;
  max_run_down: number | null;
  return_1m: number | null;
  return_3m: number | null;
  return_5m: number | null;
  volatility_5m: number | null;
  has_up_hit: number;
  has_down_hit: number;
  first_up_hit_minute: number | null;
  first_down_hit_minute: number | null;
  volume_zscore_15m: number | null;
}

interface PriceRow {
  id: number;
  trade_id: number;
  minute_offset: number;
  timestamp: number;
  price: number;
}

// ============================================================================
// Export
// ============================================================================

export { TradeRepository as default };
