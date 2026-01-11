/**
 * TradeRepository - SQLite persistence layer for Crypto15ML trades
 *
 * Implements persistent trade recording using better-sqlite3 for
 * synchronous database operations with async write support.
 *
 * Part of #25
 */

import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, statSync, readdirSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import type {
  TradeRecord,
  TradeOutcome,
  MinutePrice,
  ITradeRepository,
  RegimeStats,
  SymbolStats,
  CalibrationBucket,
  DatabaseStats,
  VolatilityRegime,
  PersistenceConfig,
  TradeSide,
  TradeOutcomeDirection,
  EvaluationRecord,
  EvaluationDecision,
  ProbabilityBucket,
  DecisionBreakdown,
  ThresholdSimulationResult,
  ModelVsMarketStats,
  PaginationOptions,
} from '../types/trade-record.types.js';
import {
  VALID_CRYPTO_ASSETS,
  VALID_TRADE_SIDES,
  VALID_VOLATILITY_REGIMES,
  VALID_TRADE_OUTCOMES,
  VALID_EVALUATION_DECISIONS,
} from '../types/trade-record.types.js';
import {
  MINUTE_MS,
  HOUR_MS,
  DEFAULT_MINUTE_OF_HOUR,
  type CryptoAsset,
  type FeatureVector,
} from '../strategies/crypto15-feature-engine.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Default allowed base directory for database files */
const DEFAULT_ALLOWED_BASE_DIR = './data';

/** Maximum number of IDs in a single batch query (SQLite limit is 999) */
const MAX_BATCH_SIZE = 500;

/** Maximum number of pending writes in the async queue */
const MAX_WRITE_QUEUE_SIZE = 1000;

/** SQLite busy timeout in milliseconds */
const BUSY_TIMEOUT_MS = 5000;

// ============================================================================
// Type Validators (Generic Factory Pattern)
// ============================================================================

/**
 * Create a type assertion function for a given set of valid values.
 * Eliminates duplication across multiple type validators.
 */
function createAsserter<T extends string>(
  typeName: string,
  validValues: readonly T[]
): {
  assert: (value: string) => T;
  assertNullable: (value: string | null) => T | undefined;
} {
  const validSet = new Set<string>(validValues);

  const assert = (value: string): T => {
    if (!validSet.has(value)) {
      throw new Error(
        `Invalid ${typeName}: ${value}. Expected one of: ${validValues.join(', ')}`
      );
    }
    return value as T;
  };

  const assertNullable = (value: string | null): T | undefined => {
    if (value === null) return undefined;
    return assert(value);
  };

  return { assert, assertNullable };
}

// Create type-safe assertion functions
const cryptoAssetAsserter = createAsserter<CryptoAsset>('CryptoAsset', VALID_CRYPTO_ASSETS);
const tradeSideAsserter = createAsserter<TradeSide>('TradeSide', VALID_TRADE_SIDES);
const volatilityRegimeAsserter = createAsserter<VolatilityRegime>('VolatilityRegime', VALID_VOLATILITY_REGIMES);
const tradeOutcomeAsserter = createAsserter<TradeOutcomeDirection>('TradeOutcome', VALID_TRADE_OUTCOMES);
const evaluationDecisionAsserter = createAsserter<EvaluationDecision>('EvaluationDecision', VALID_EVALUATION_DECISIONS);

// Convenience aliases for existing usage patterns
const assertCryptoAsset = cryptoAssetAsserter.assert;
const assertTradeSide = tradeSideAsserter.assert;
const assertVolatilityRegime = volatilityRegimeAsserter.assertNullable;
const assertVolatilityRegimeRequired = volatilityRegimeAsserter.assert;
const assertTradeOutcome = tradeOutcomeAsserter.assertNullable;
const assertEvaluationDecision = evaluationDecisionAsserter.assert;

/**
 * Convert boolean to SQLite integer
 */
function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

// ============================================================================
// TradeRepository Implementation
// ============================================================================

export class TradeRepository implements ITradeRepository {
  private db: Database.Database | null = null;
  private config: PersistenceConfig;
  private writeQueue: Array<() => void> = [];
  private isProcessingQueue = false;

  // Cached prepared statements
  private statements: {
    insertTrade?: Statement;
    insertFeatures?: Statement;
    updateOutcome?: Statement;
    insertPrice?: Statement;
    insertEvaluation?: Statement;
    selectByConditionId?: Statement;
    selectById?: Statement;
    selectPending?: Statement;
    selectByDateRange?: Statement;
    selectBySymbol?: Statement;
    selectFeatures?: Statement;
    selectPrices?: Statement;
    selectStats?: Statement;
    selectRegimeStats?: Statement;
    selectSymbolStats?: Statement;
    selectAllSymbolStats?: Statement;
    selectAllRegimeStats?: Statement;
    selectCalibration?: Statement;
    selectEvaluationById?: Statement;
    // Analytics statements (cached for performance)
    selectEvaluationsByDateRange?: Statement;
    selectEvaluationsByDateRangeWithLimit?: Statement;
    selectProbabilityDistribution?: Statement;
    selectDecisionBreakdown?: Statement;
    selectSimulateThresholdCounts?: Statement;
    selectNewOpportunities?: Statement;
    selectLostTrades?: Statement;
    selectModelVsMarket?: Statement;
  } = {};

  constructor(config: Partial<PersistenceConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      dbPath: config.dbPath ?? './data/crypto15ml/trades.db',
      syncMode: config.syncMode ?? 'async',
      vacuumIntervalHours: config.vacuumIntervalHours ?? 24,
    };
  }

  // ============================================================================
  // Database Access (Safe Getter)
  // ============================================================================

  /**
   * Get the database connection, throwing if not initialized.
   * This replaces all `this.db!` non-null assertions with a type-safe accessor.
   */
  private get database(): Database.Database {
    if (!this.db) {
      throw new Error('TradeRepository not initialized. Call initialize() first.');
    }
    return this.db;
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

    // Validate database path is within allowed directory
    this.validateDbPath(this.config.dbPath);

    // Ensure directory exists (mkdirSync with recursive handles existing dirs)
    const dbDir = dirname(this.config.dbPath);
    try {
      mkdirSync(dbDir, { recursive: true });
    } catch (error) {
      // Only throw if error is not EEXIST (directory already exists)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    // Open database connection
    this.db = new Database(this.config.dbPath);

    // Enable foreign keys, WAL mode, and set busy timeout for better performance
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Run migrations
    await this.runMigrations();

    // Initialize prepared statements
    this.initializeStatements();
  }

  /**
   * Validate that the database path is within an allowed directory.
   * Uses realpathSync after directory creation to catch symlink attacks.
   */
  private validateDbPath(dbPath: string): void {
    const resolvedPath = resolve(dbPath);
    const allowedBase = resolve(DEFAULT_ALLOWED_BASE_DIR);
    const testBase = resolve('./test-data');

    // First check the resolved path
    if (!resolvedPath.startsWith(allowedBase) && !resolvedPath.startsWith(testBase)) {
      throw new Error('Invalid database path specified');
    }

    // If the path already exists, verify it's not a symlink pointing outside
    const dbDir = dirname(resolvedPath);
    if (existsSync(dbDir)) {
      try {
        const realDir = realpathSync(dbDir);
        const realAllowedBase = realpathSync(allowedBase);
        const realTestBase = existsSync(testBase) ? realpathSync(testBase) : testBase;

        if (!realDir.startsWith(realAllowedBase) && !realDir.startsWith(realTestBase)) {
          throw new Error('Invalid database path specified');
        }
      } catch (error) {
        // If realpathSync fails on allowed bases, just use the original check
        if ((error as Error).message === 'Invalid database path specified') {
          throw error;
        }
      }
    }
  }

  /**
   * Initialize cached prepared statements for better performance
   */
  private initializeStatements(): void {
    const db = this.database;

    this.statements.insertTrade = db.prepare(`
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

    this.statements.insertFeatures = db.prepare(`
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

    this.statements.updateOutcome = db.prepare(`
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

    this.statements.insertPrice = db.prepare(`
      INSERT OR REPLACE INTO trade_prices (trade_id, minute_offset, timestamp, price)
      VALUES (@tradeId, @minuteOffset, @timestamp, @price)
    `);

    this.statements.insertEvaluation = db.prepare(`
      INSERT INTO evaluations (
        condition_id, slug, symbol, timestamp, state_minute,
        model_probability, linear_combination, imputed_count,
        market_price_yes, market_price_no, decision, reason, features_json
      ) VALUES (
        @conditionId, @slug, @symbol, @timestamp, @stateMinute,
        @modelProbability, @linearCombination, @imputedCount,
        @marketPriceYes, @marketPriceNo, @decision, @reason, @featuresJson
      )
    `);

    this.statements.selectEvaluationById = db.prepare(`
      SELECT * FROM evaluations WHERE id = ?
    `);

    this.statements.selectByConditionId = db.prepare(`
      SELECT * FROM trades WHERE condition_id = ?
    `);

    this.statements.selectById = db.prepare(`
      SELECT * FROM trades WHERE id = ?
    `);

    this.statements.selectPending = db.prepare(`
      SELECT * FROM trades WHERE outcome IS NULL ORDER BY signal_timestamp ASC LIMIT ?
    `);

    this.statements.selectByDateRange = db.prepare(`
      SELECT * FROM trades
      WHERE signal_timestamp >= ? AND signal_timestamp <= ?
      ORDER BY signal_timestamp ASC
    `);

    this.statements.selectBySymbol = db.prepare(`
      SELECT * FROM trades WHERE symbol = ? ORDER BY signal_timestamp ASC
    `);

    this.statements.selectFeatures = db.prepare(`
      SELECT * FROM trade_features WHERE trade_id = ?
    `);

    this.statements.selectPrices = db.prepare(`
      SELECT * FROM trade_prices WHERE trade_id = ? ORDER BY minute_offset ASC
    `);

    this.statements.selectStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved,
        MIN(signal_timestamp) as oldest,
        MAX(signal_timestamp) as newest
      FROM trades
    `);

    this.statements.selectRegimeStats = db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
        AVG(is_win) as win_rate,
        AVG(pnl) as avg_pnl,
        SUM(pnl) as total_pnl
      FROM trades
      WHERE volatility_regime = ? AND outcome IS NOT NULL
    `);

    this.statements.selectSymbolStats = db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
        AVG(is_win) as win_rate,
        AVG(pnl) as avg_pnl,
        SUM(pnl) as total_pnl
      FROM trades
      WHERE symbol = ? AND outcome IS NOT NULL
    `);

    this.statements.selectAllSymbolStats = db.prepare(`
      SELECT
        symbol,
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
        AVG(is_win) as win_rate,
        AVG(pnl) as avg_pnl,
        SUM(pnl) as total_pnl
      FROM trades
      WHERE outcome IS NOT NULL
      GROUP BY symbol
      ORDER BY total_trades DESC
    `);

    this.statements.selectAllRegimeStats = db.prepare(`
      SELECT
        volatility_regime,
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
        AVG(is_win) as win_rate,
        AVG(pnl) as avg_pnl,
        SUM(pnl) as total_pnl
      FROM trades
      WHERE outcome IS NOT NULL AND volatility_regime IS NOT NULL
      GROUP BY volatility_regime
      ORDER BY total_trades DESC
    `);

    this.statements.selectCalibration = db.prepare(`
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

    // ========================================================================
    // Evaluation Analytics Statements (cached for performance)
    // ========================================================================

    this.statements.selectEvaluationsByDateRange = db.prepare(`
      SELECT * FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);

    this.statements.selectEvaluationsByDateRangeWithLimit = db.prepare(`
      SELECT * FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `);

    this.statements.selectDecisionBreakdown = db.prepare(`
      SELECT
        symbol,
        SUM(CASE WHEN decision = 'SKIP' THEN 1 ELSE 0 END) as skip_count,
        SUM(CASE WHEN decision = 'YES' THEN 1 ELSE 0 END) as yes_count,
        SUM(CASE WHEN decision = 'NO' THEN 1 ELSE 0 END) as no_count,
        AVG(CASE WHEN decision = 'SKIP' THEN model_probability ELSE NULL END) as avg_skip_prob
      FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY symbol
      ORDER BY symbol ASC
    `);

    this.statements.selectSimulateThresholdCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN decision != 'SKIP' THEN 1 ELSE 0 END) as actually_traded,
        SUM(CASE WHEN model_probability >= ? OR model_probability <= ? THEN 1 ELSE 0 END) as would_trade
      FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
    `);

    this.statements.selectNewOpportunities = db.prepare(`
      SELECT * FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
        AND decision = 'SKIP'
        AND (model_probability >= ? OR model_probability <= ?)
      ORDER BY timestamp ASC
    `);

    this.statements.selectLostTrades = db.prepare(`
      SELECT * FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
        AND decision != 'SKIP'
        AND model_probability < ?
        AND model_probability > ?
      ORDER BY timestamp ASC
    `);

    // Single query for model vs market with SQL-computed Pearson correlation
    this.statements.selectModelVsMarket = db.prepare(`
      SELECT
        symbol,
        AVG(model_probability) as avg_model_prob,
        AVG(market_price_yes) as avg_market_price_yes,
        COUNT(*) as evaluation_count,
        CASE
          WHEN COUNT(*) < 2 THEN 0
          WHEN (COUNT(*) * SUM(model_probability * model_probability) - SUM(model_probability) * SUM(model_probability)) *
               (COUNT(*) * SUM(market_price_yes * market_price_yes) - SUM(market_price_yes) * SUM(market_price_yes)) <= 0 THEN 0
          ELSE (COUNT(*) * SUM(model_probability * market_price_yes) - SUM(model_probability) * SUM(market_price_yes)) /
               SQRT((COUNT(*) * SUM(model_probability * model_probability) - SUM(model_probability) * SUM(model_probability)) *
                    (COUNT(*) * SUM(market_price_yes * market_price_yes) - SUM(market_price_yes) * SUM(market_price_yes)))
        END as correlation
      FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY symbol
      ORDER BY symbol ASC
    `);
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    // Process any remaining writes
    await this.flushWriteQueue();

    // Finalize all prepared statements before clearing
    for (const stmt of Object.values(this.statements)) {
      if (stmt) {
        try {
          // better-sqlite3 statements don't have finalize, but clearing helps GC
          // The database.close() will handle cleanup
        } catch {
          // Ignore finalization errors during shutdown
        }
      }
    }

    // Clear cached statements
    this.statements = {};

    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ============================================================================
  // Statement Access (Safe Getters)
  // ============================================================================

  /**
   * Safely get a prepared statement, throwing a descriptive error if not initialized.
   */
  private getStatement<K extends keyof typeof this.statements>(
    name: K
  ): NonNullable<(typeof this.statements)[K]> {
    const stmt = this.statements[name];
    if (!stmt) {
      throw new Error(
        `Statement '${name}' not initialized. Ensure initialize() was called successfully.`
      );
    }
    return stmt as NonNullable<(typeof this.statements)[K]>;
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Execute a write operation, handling sync/async mode.
   * In async mode, errors are properly propagated via promise rejection.
   */
  private executeWrite<T>(operation: () => T): Promise<T> {
    if (this.config.syncMode === 'sync') {
      return Promise.resolve(operation());
    }

    // Check queue size limit to prevent memory exhaustion
    if (this.writeQueue.length >= MAX_WRITE_QUEUE_SIZE) {
      return Promise.reject(
        new Error(`Write queue full (limit: ${MAX_WRITE_QUEUE_SIZE}). Try again later.`)
      );
    }

    // Async mode: queue the write with proper error handling
    return new Promise((resolve, reject) => {
      try {
        this.queueWrite(() => {
          try {
            const result = operation();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Record a new trade with its features.
   * Uses a transaction to ensure atomicity - both trade and features are
   * inserted together or neither is inserted.
   * @returns The database ID of the inserted trade
   */
  async recordTrade(trade: TradeRecord): Promise<number> {
    this.ensureInitialized();

    return this.executeWrite(() => {
      // Wrap in transaction for atomicity (trade + features)
      const insertTradeWithFeatures = this.database.transaction(() => {
        const stmt = this.getStatement('insertTrade');

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

        const tradeId = this.toSafeId(result.lastInsertRowid, 'Trade');

        // Insert features (within same transaction)
        this.insertFeatures(tradeId, trade.features);

        return tradeId;
      });

      return insertTradeWithFeatures();
    });
  }

  /**
   * Update trade outcome on resolution
   */
  async updateOutcome(conditionId: string, outcome: TradeOutcome): Promise<void> {
    this.ensureInitialized();

    return this.executeWrite(() => {
      const stmt = this.getStatement('updateOutcome');

      stmt.run({
        conditionId,
        outcome: outcome.outcome,
        isWin: boolToInt(outcome.isWin),
        pnl: outcome.pnl,
        resolutionTimestamp: outcome.resolutionTimestamp,
        windowClosePrice: outcome.windowClosePrice,
        timeToUpThreshold: outcome.timeToUpThreshold ?? null,
        timeToDownThreshold: outcome.timeToDownThreshold ?? null,
        maxFavorableExcursion: outcome.maxFavorableExcursion,
        maxAdverseExcursion: outcome.maxAdverseExcursion,
        updatedAt: Date.now(),
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

    return this.executeWrite(() => {
      const stmt = this.getStatement('insertPrice');

      stmt.run({
        tradeId,
        minuteOffset: minute,
        timestamp,
        price,
      });
    });
  }

  /**
   * Record multiple minute price snapshots in a single batch operation
   *
   * More efficient than multiple individual recordMinutePrice calls
   * when persisting prices collected before trade was recorded.
   * Uses a single transaction for all inserts.
   */
  async recordMinutePrices(
    tradeId: number,
    prices: ReadonlyArray<MinutePrice>
  ): Promise<void> {
    this.ensureInitialized();

    if (prices.length === 0) {
      return;
    }

    return this.executeWrite(() => {
      const stmt = this.getStatement('insertPrice');

      // Run all inserts in a single transaction (already in executeWrite context)
      for (const mp of prices) {
        stmt.run({
          tradeId,
          minuteOffset: mp.minuteOffset,
          timestamp: mp.timestamp,
          price: mp.price,
        });
      }
    });
  }

  // ============================================================================
  // Evaluation Write Operations
  // ============================================================================

  /**
   * Record a single market evaluation.
   * Uses async write mode by default for zero latency impact.
   * @returns The database ID of the inserted evaluation
   */
  async recordEvaluation(evaluation: EvaluationRecord): Promise<number> {
    this.ensureInitialized();

    return this.executeWrite(() => {
      const stmt = this.getStatement('insertEvaluation');
      const params = this.evaluationToParams(evaluation);
      const result = stmt.run(params);
      return this.toSafeId(result.lastInsertRowid, 'Evaluation');
    });
  }

  /**
   * Record multiple evaluations in a single batch operation.
   * More efficient than multiple individual recordEvaluation calls.
   * Uses a single transaction for all inserts.
   * @returns Array of database IDs for the inserted evaluations
   */
  async recordEvaluations(evaluations: ReadonlyArray<EvaluationRecord>): Promise<number[]> {
    this.ensureInitialized();

    if (evaluations.length === 0) {
      return [];
    }

    return this.executeWrite(() => {
      const stmt = this.getStatement('insertEvaluation');

      // Transaction returns IDs directly for cleaner functional style
      const batchInsert = this.database.transaction((evals: ReadonlyArray<EvaluationRecord>) => {
        const insertedIds: number[] = [];
        for (const evaluation of evals) {
          const params = this.evaluationToParams(evaluation);
          const result = stmt.run(params);
          insertedIds.push(this.toSafeId(result.lastInsertRowid, 'Evaluation'));
        }
        return insertedIds;
      });

      return batchInsert(evaluations);
    });
  }

  /**
   * Get evaluation by database ID.
   */
  async getEvaluationById(id: number): Promise<EvaluationRecord | null> {
    this.ensureInitialized();

    const row = this.getStatement('selectEvaluationById').get(id) as EvaluationRow | undefined;
    if (!row) return null;

    return this.rowToEvaluationRecord(row);
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Get trade by Polymarket condition ID
   */
  async getTradeByConditionId(conditionId: string): Promise<TradeRecord | null> {
    this.ensureInitialized();

    const row = this.getStatement('selectByConditionId').get(conditionId) as TradeRow | undefined;
    if (!row) return null;

    return this.rowToTradeRecord(row);
  }

  /**
   * Get trade by database ID
   */
  async getTradeById(id: number): Promise<TradeRecord | null> {
    this.ensureInitialized();

    const row = this.getStatement('selectById').get(id) as TradeRow | undefined;
    if (!row) return null;

    return this.rowToTradeRecord(row);
  }

  /**
   * Get all trades awaiting resolution
   * @param limit Maximum number of trades to return (default: 1000)
   */
  async getPendingTrades(limit: number = 1000): Promise<TradeRecord[]> {
    this.ensureInitialized();

    const rows = this.getStatement('selectPending').all(limit) as TradeRow[];
    return this.rowsToTradeRecords(rows);
  }

  // ============================================================================
  // Analysis Queries
  // ============================================================================

  /**
   * Get trades within a date range
   */
  async getTradesByDateRange(start: Date, end: Date): Promise<TradeRecord[]> {
    this.ensureInitialized();

    const rows = this.getStatement('selectByDateRange').all(start.getTime(), end.getTime()) as TradeRow[];
    return this.rowsToTradeRecords(rows);
  }

  /**
   * Get trades for a specific symbol
   */
  async getTradesBySymbol(symbol: CryptoAsset): Promise<TradeRecord[]> {
    this.ensureInitialized();

    const rows = this.getStatement('selectBySymbol').all(symbol) as TradeRow[];
    return this.rowsToTradeRecords(rows);
  }

  /**
   * Get performance statistics by volatility regime
   */
  async getPerformanceByRegime(regime: VolatilityRegime): Promise<RegimeStats> {
    this.ensureInitialized();

    const row = this.getStatement('selectRegimeStats').get(regime) as StatsRow | undefined;

    return {
      regime,
      ...mapBaseStats(row),
    };
  }

  /**
   * Get performance statistics for all volatility regimes
   */
  async getAllRegimeStats(): Promise<RegimeStats[]> {
    this.ensureInitialized();

    const rows = this.getStatement('selectAllRegimeStats').all() as RegimeStatsRow[];

    return rows.map((row): RegimeStats => ({
      regime: assertVolatilityRegimeRequired(row.volatility_regime),
      ...mapBaseStats(row),
    }));
  }

  /**
   * Get performance statistics for a specific symbol
   */
  async getSymbolStats(symbol: CryptoAsset): Promise<SymbolStats> {
    this.ensureInitialized();

    const row = this.getStatement('selectSymbolStats').get(symbol) as StatsRow | undefined;

    return {
      symbol,
      ...mapBaseStats(row),
    };
  }

  /**
   * Get performance statistics for all symbols
   */
  async getAllSymbolStats(): Promise<SymbolStats[]> {
    this.ensureInitialized();

    const rows = this.getStatement('selectAllSymbolStats').all() as SymbolStatsRow[];

    return rows.map((row): SymbolStats => ({
      symbol: assertCryptoAsset(row.symbol),
      ...mapBaseStats(row),
    }));
  }

  /**
   * Get calibration data for all probability buckets
   */
  async getCalibrationData(): Promise<CalibrationBucket[]> {
    this.ensureInitialized();

    const rows = this.getStatement('selectCalibration').all() as Array<{
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
    this.database.exec('VACUUM');
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<DatabaseStats> {
    this.ensureInitialized();

    const row = this.getStatement('selectStats').get() as {
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
  // Transaction Support
  // ============================================================================

  /**
   * Execute multiple operations within a single transaction.
   * All operations will either succeed together or fail together.
   * @param fn Function containing the operations to execute
   * @returns The result of the function
   */
  async transaction<T>(fn: () => T): Promise<T> {
    this.ensureInitialized();

    const txn = this.database.transaction(fn);
    return txn();
  }

  // ============================================================================
  // Evaluation Analytics (Part of #38)
  // ============================================================================

  /**
   * Get evaluations within a date range.
   * @param start Start date (inclusive)
   * @param end End date (inclusive)
   * @param options Pagination options (limit and offset)
   * @returns Array of evaluation records
   */
  async getEvaluationsByDateRange(
    start: Date,
    end: Date,
    options?: PaginationOptions
  ): Promise<EvaluationRecord[]> {
    this.ensureInitialized();

    let rows: EvaluationRow[];

    if (options?.limit !== undefined) {
      const stmt = this.getStatement('selectEvaluationsByDateRangeWithLimit');
      rows = stmt.all(
        start.getTime(),
        end.getTime(),
        options.limit,
        options.offset ?? 0
      ) as EvaluationRow[];
    } else {
      const stmt = this.getStatement('selectEvaluationsByDateRange');
      rows = stmt.all(start.getTime(), end.getTime()) as EvaluationRow[];
    }

    return rows.map((row) => this.rowToEvaluationRecord(row));
  }

  /** Default bucket size for probability distribution histograms */
  private static readonly DEFAULT_PROBABILITY_BUCKET_SIZE = 0.05;

  /**
   * Get probability distribution histogram for model probabilities.
   * Shows how model predictions are distributed across probability ranges.
   *
   * @param start Start date (inclusive)
   * @param end End date (inclusive)
   * @param bucketSize Size of each bucket (default: 0.05). Must be in range (0, 1].
   * @returns Array of probability buckets with counts and avg market prices
   */
  async getProbabilityDistribution(
    start: Date,
    end: Date,
    bucketSize: number = TradeRepository.DEFAULT_PROBABILITY_BUCKET_SIZE
  ): Promise<ProbabilityBucket[]> {
    this.ensureInitialized();

    // Validate bucket size
    if (bucketSize <= 0 || bucketSize > 1) {
      throw new Error('bucketSize must be between 0 (exclusive) and 1 (inclusive)');
    }

    // Use SQL to bucket the probabilities (dynamic query due to variable bucketSize)
    // FLOOR(probability / bucketSize) * bucketSize gives us the bucket start
    const stmt = this.database.prepare(`
      SELECT
        CAST(FLOOR(model_probability / ?) * ? AS REAL) as bucket_start,
        COUNT(*) as count,
        AVG(market_price_yes) as avg_market_price
      FROM evaluations
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY FLOOR(model_probability / ?)
      ORDER BY bucket_start ASC
    `);

    const rows = stmt.all(
      bucketSize,
      bucketSize,
      start.getTime(),
      end.getTime(),
      bucketSize
    ) as ProbabilityDistributionRow[];

    return rows.map((row) => {
      const bucketStart = row.bucket_start;
      const bucketEnd = Math.min(bucketStart + bucketSize, 1);
      return {
        bucket: `${bucketStart.toFixed(2)}-${bucketEnd.toFixed(2)}`,
        count: row.count,
        avgMarketPrice: row.avg_market_price,
      };
    });
  }

  /**
   * Get decision breakdown by symbol showing how often each decision occurs.
   *
   * @param start Start date (inclusive)
   * @param end End date (inclusive)
   * @returns Array of decision breakdowns per symbol
   */
  async getDecisionBreakdown(start: Date, end: Date): Promise<DecisionBreakdown[]> {
    this.ensureInitialized();

    const stmt = this.getStatement('selectDecisionBreakdown');
    const rows = stmt.all(start.getTime(), end.getTime()) as DecisionBreakdownRow[];

    return rows.map((row) => ({
      symbol: assertCryptoAsset(row.symbol),
      skipCount: row.skip_count,
      yesCount: row.yes_count,
      noCount: row.no_count,
      avgSkipProb: row.avg_skip_prob ?? 0,
    }));
  }

  /**
   * Simulate different thresholds for what-if analysis.
   * Shows what trades would have been made with different YES/NO thresholds.
   *
   * This assumes the current strategy logic:
   * - YES trade if model_probability >= yesThreshold
   * - NO trade if (1 - model_probability) >= noThreshold (i.e., model_probability <= 1 - noThreshold)
   *
   * Uses SQL aggregation for counts (efficient) and only fetches full records for
   * the new opportunities and lost trades arrays (typically much smaller than total).
   *
   * @param start Start date (inclusive)
   * @param end End date (inclusive)
   * @param yesThreshold Probability threshold for YES trades (e.g., 0.65). Must be in range [0, 1].
   * @param noThreshold Probability threshold for NO trades (e.g., 0.65). Must be in range [0, 1].
   * @returns Simulation result with trade counts and opportunity lists
   */
  async simulateThreshold(
    start: Date,
    end: Date,
    yesThreshold: number,
    noThreshold: number
  ): Promise<ThresholdSimulationResult> {
    this.ensureInitialized();

    // Validate thresholds
    if (yesThreshold < 0 || yesThreshold > 1) {
      throw new Error('yesThreshold must be between 0 (inclusive) and 1 (inclusive)');
    }
    if (noThreshold < 0 || noThreshold > 1) {
      throw new Error('noThreshold must be between 0 (inclusive) and 1 (inclusive)');
    }

    const noThresholdLower = 1 - noThreshold;
    const startMs = start.getTime();
    const endMs = end.getTime();

    // Get counts via SQL aggregation (efficient - no data loaded into memory)
    const countsStmt = this.getStatement('selectSimulateThresholdCounts');
    const countsRow = countsStmt.get(
      yesThreshold,
      noThresholdLower,
      startMs,
      endMs
    ) as SimulateThresholdCountsRow | undefined;

    const actuallyTraded = countsRow?.actually_traded ?? 0;
    const wouldTrade = countsRow?.would_trade ?? 0;

    // Fetch only the new opportunities (SKIPs that would now trade)
    const newOppsStmt = this.getStatement('selectNewOpportunities');
    const newOppsRows = newOppsStmt.all(
      startMs,
      endMs,
      yesThreshold,
      noThresholdLower
    ) as EvaluationRow[];
    const newOpportunities = newOppsRows.map((row) => this.rowToEvaluationRecord(row));

    // Fetch only the lost trades (trades that would now be skipped)
    const lostStmt = this.getStatement('selectLostTrades');
    const lostRows = lostStmt.all(
      startMs,
      endMs,
      yesThreshold,
      noThresholdLower
    ) as EvaluationRow[];
    const lostTrades = lostRows.map((row) => this.rowToEvaluationRecord(row));

    return {
      wouldTrade,
      actuallyTraded,
      newOpportunities,
      lostTrades,
    };
  }

  /**
   * Compare model predictions against market prices.
   * Calculates Pearson correlation between model probability and market YES price.
   *
   * Uses a single SQL query that computes the correlation in the database,
   * avoiding the need to load all data into memory.
   *
   * @param start Start date (inclusive)
   * @param end End date (inclusive)
   * @returns Array of model vs market stats per symbol
   */
  async getModelVsMarket(start: Date, end: Date): Promise<ModelVsMarketStats[]> {
    this.ensureInitialized();

    const stmt = this.getStatement('selectModelVsMarket');
    const rows = stmt.all(start.getTime(), end.getTime()) as ModelVsMarketRow[];

    return rows.map((row) => ({
      symbol: assertCryptoAsset(row.symbol),
      avgModelProb: row.avg_model_prob,
      avgMarketPriceYes: row.avg_market_price_yes,
      correlation: row.correlation,
      evaluationCount: row.evaluation_count,
    }));
  }

  // ============================================================================
  // Migration Support
  // ============================================================================

  /**
   * Run pending migrations
   */
  private async runMigrations(): Promise<void> {
    const db = this.database;

    // Get current schema version
    let currentVersion = 0;
    try {
      const versionStmt = db.prepare(
        'SELECT MAX(version) as version FROM schema_version'
      );
      const row = versionStmt.get() as { version: number | null } | undefined;
      currentVersion = row?.version ?? 0;
    } catch {
      // Schema version table doesn't exist yet, version is 0
    }

    // Load and run migrations
    const migrationFiles = this.getMigrationFiles();

    for (const file of migrationFiles) {
      const version = this.extractMigrationVersion(file);
      if (version > currentVersion) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
        db.exec(sql);
      }
    }
  }

  /**
   * Get sorted list of migration files
   */
  private getMigrationFiles(): string[] {
    try {
      const files = readdirSync(MIGRATIONS_DIR);
      return files
        .filter((f: string) => f.endsWith('.sql'))
        .sort((a: string, b: string) => {
          const versionA = this.extractMigrationVersion(a);
          const versionB = this.extractMigrationVersion(b);
          return versionA - versionB;
        });
    } catch {
      // Migrations directory doesn't exist
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
   * Ensure database is initialized (for methods that don't use this.database getter)
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
   * Safely convert bigint lastInsertRowid to number, throwing if out of safe range.
   */
  private toSafeId(rowid: number | bigint, entityName: string): number {
    const id = Number(rowid);
    if (!Number.isSafeInteger(id)) {
      throw new Error(`${entityName} ID ${rowid} exceeds safe integer range`);
    }
    return id;
  }

  /**
   * Validate and convert an EvaluationRecord to prepared statement parameters.
   * Performs input validation for JSON and decision field.
   */
  private evaluationToParams(evaluation: EvaluationRecord): Record<string, unknown> {
    // Validate JSON is parseable
    try {
      JSON.parse(evaluation.featuresJson);
    } catch {
      throw new Error('Invalid JSON in featuresJson field');
    }

    // Validate decision against allowed values
    if (!VALID_EVALUATION_DECISIONS.includes(evaluation.decision)) {
      throw new Error(
        `Invalid decision: ${evaluation.decision}. Expected one of: ${VALID_EVALUATION_DECISIONS.join(', ')}`
      );
    }

    return {
      conditionId: evaluation.conditionId,
      slug: evaluation.slug,
      symbol: evaluation.symbol,
      timestamp: evaluation.timestamp,
      stateMinute: evaluation.stateMinute,
      modelProbability: evaluation.modelProbability,
      linearCombination: evaluation.linearCombination,
      imputedCount: evaluation.imputedCount,
      marketPriceYes: evaluation.marketPriceYes,
      marketPriceNo: evaluation.marketPriceNo,
      decision: evaluation.decision,
      reason: evaluation.reason,
      featuresJson: evaluation.featuresJson,
    };
  }

  /**
   * Insert feature vector for a trade
   */
  private insertFeatures(tradeId: number, features: FeatureVector): void {
    const stmt = this.getStatement('insertFeatures');

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
      hasUpHit: boolToInt(features.hasUpHit),
      hasDownHit: boolToInt(features.hasDownHit),
      firstUpHitMinute: this.nullifyNaN(features.firstUpHitMinute),
      firstDownHitMinute: this.nullifyNaN(features.firstDownHitMinute),
    });
  }

  /**
   * Batch fetch features for multiple trades (fixes N+1 query).
   * Chunks large arrays to stay within SQLite's parameter limit.
   */
  private batchGetFeatures(tradeIds: number[]): Map<number, FeatureRow> {
    if (tradeIds.length === 0) return new Map();

    const map = new Map<number, FeatureRow>();

    // Process in chunks to avoid SQLite parameter limit (999)
    for (let i = 0; i < tradeIds.length; i += MAX_BATCH_SIZE) {
      const chunk = tradeIds.slice(i, i + MAX_BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const stmt = this.database.prepare(`
        SELECT * FROM trade_features WHERE trade_id IN (${placeholders})
      `);

      const rows = stmt.all(...chunk) as FeatureRow[];
      for (const row of rows) {
        map.set(row.trade_id, row);
      }
    }

    return map;
  }

  /**
   * Batch fetch minute prices for multiple trades (fixes N+1 query).
   * Chunks large arrays to stay within SQLite's parameter limit.
   */
  private batchGetPrices(tradeIds: number[]): Map<number, PriceRow[]> {
    if (tradeIds.length === 0) return new Map();

    const map = new Map<number, PriceRow[]>();

    // Process in chunks to avoid SQLite parameter limit (999)
    for (let i = 0; i < tradeIds.length; i += MAX_BATCH_SIZE) {
      const chunk = tradeIds.slice(i, i + MAX_BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const stmt = this.database.prepare(`
        SELECT * FROM trade_prices WHERE trade_id IN (${placeholders}) ORDER BY minute_offset ASC
      `);

      const rows = stmt.all(...chunk) as PriceRow[];
      for (const row of rows) {
        const existing = map.get(row.trade_id) || [];
        existing.push(row);
        map.set(row.trade_id, existing);
      }
    }

    return map;
  }

  /**
   * Get features for a single trade
   */
  private getFeatures(tradeId: number): FeatureRow | null {
    const row = this.getStatement('selectFeatures').get(tradeId) as FeatureRow | undefined;
    return row ?? null;
  }

  /**
   * Get minute prices for a single trade
   */
  private getMinutePrices(tradeId: number): MinutePrice[] {
    const rows = this.getStatement('selectPrices').all(tradeId) as PriceRow[];
    return rows.map((row) => ({
      minuteOffset: row.minute_offset,
      timestamp: row.timestamp,
      price: row.price,
    }));
  }

  /**
   * Convert a feature row to FeatureVector
   */
  private featureRowToVector(row: FeatureRow, symbol: CryptoAsset, timestamp: number): FeatureVector {
    // Compute minuteOfHour from timestamp if available, otherwise use default
    // Note: minute_of_hour not stored in DB - derive from timestamp or use mid-hour default
    const minuteOfHour = timestamp > 0
      ? Math.floor((timestamp % HOUR_MS) / MINUTE_MS)
      : DEFAULT_MINUTE_OF_HOUR;

    return {
      stateMinute: row.state_minute,
      minutesRemaining: row.minutes_remaining,
      hourOfDay: row.hour_of_day,
      minuteOfHour,
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
      asset: symbol,
      timestamp,
    };
  }

  /**
   * Convert multiple database rows to TradeRecords with batched queries (fixes N+1)
   */
  private rowsToTradeRecords(rows: TradeRow[]): TradeRecord[] {
    if (rows.length === 0) return [];

    const tradeIds = rows.map((r) => r.id);
    const featuresMap = this.batchGetFeatures(tradeIds);
    const pricesMap = this.batchGetPrices(tradeIds);

    return rows.map((row) => {
      const featureRow = featuresMap.get(row.id);
      if (!featureRow) {
        throw new Error(`Data integrity error: Features not found for trade ${row.id}`);
      }

      const symbol = assertCryptoAsset(row.symbol);
      const features = this.featureRowToVector(featureRow, symbol, row.signal_timestamp);
      const priceRows = pricesMap.get(row.id) || [];
      const minutePrices = priceRows.map((p) => ({
        minuteOffset: p.minute_offset,
        timestamp: p.timestamp,
        price: p.price,
      }));

      return this.buildTradeRecord(row, features, minutePrices);
    });
  }

  /**
   * Convert a single database row to TradeRecord
   */
  private rowToTradeRecord(row: TradeRow): TradeRecord {
    const featureRow = this.getFeatures(row.id);
    if (!featureRow) {
      throw new Error(`Data integrity error: Features not found for trade ${row.id}`);
    }

    const symbol = assertCryptoAsset(row.symbol);
    const features = this.featureRowToVector(featureRow, symbol, row.signal_timestamp);
    const minutePrices = this.getMinutePrices(row.id);

    return this.buildTradeRecord(row, features, minutePrices);
  }

  /**
   * Build a TradeRecord from validated components
   */
  private buildTradeRecord(
    row: TradeRow,
    features: FeatureVector,
    minutePrices: MinutePrice[]
  ): TradeRecord {
    return {
      id: row.id,
      conditionId: row.condition_id,
      slug: row.slug,
      symbol: assertCryptoAsset(row.symbol),
      side: assertTradeSide(row.side),
      entryPrice: row.entry_price,
      positionSize: row.position_size,
      signalTimestamp: row.signal_timestamp,
      probability: row.probability,
      linearCombination: row.linear_combination,
      imputedCount: row.imputed_count,
      features,
      outcome: assertTradeOutcome(row.outcome),
      isWin: row.is_win === null ? undefined : row.is_win === 1,
      pnl: row.pnl ?? undefined,
      resolutionTimestamp: row.resolution_timestamp ?? undefined,
      stateMinute: row.state_minute,
      hourOfDay: row.hour_of_day,
      dayOfWeek: row.day_of_week,
      volatilityRegime: assertVolatilityRegime(row.volatility_regime),
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
   * Convert an evaluation row to EvaluationRecord
   */
  private rowToEvaluationRecord(row: EvaluationRow): EvaluationRecord {
    return {
      id: row.id,
      conditionId: row.condition_id,
      slug: row.slug,
      symbol: assertCryptoAsset(row.symbol),
      timestamp: row.timestamp,
      stateMinute: row.state_minute,
      modelProbability: row.model_probability,
      linearCombination: row.linear_combination,
      imputedCount: row.imputed_count,
      marketPriceYes: row.market_price_yes,
      marketPriceNo: row.market_price_no,
      decision: assertEvaluationDecision(row.decision),
      reason: row.reason,
      featuresJson: row.features_json,
      createdAt: row.created_at ?? undefined,
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
          const message = error instanceof Error ? error.message : String(error);
          console.error('TradeRepository write error:', message);
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

/**
 * Evaluation row from database query
 */
interface EvaluationRow {
  id: number;
  condition_id: string;
  slug: string;
  symbol: string;
  timestamp: number;
  state_minute: number;
  model_probability: number;
  linear_combination: number;
  imputed_count: number;
  market_price_yes: number;
  market_price_no: number;
  decision: string;
  reason: string;
  features_json: string;
  created_at: number | null;
}

// ============================================================================
// Analytics Row Types (named interfaces for type safety)
// ============================================================================

/**
 * Row from probability distribution query
 */
interface ProbabilityDistributionRow {
  bucket_start: number;
  count: number;
  avg_market_price: number;
}

/**
 * Row from decision breakdown query
 */
interface DecisionBreakdownRow {
  symbol: string;
  skip_count: number;
  yes_count: number;
  no_count: number;
  avg_skip_prob: number | null;
}

/**
 * Row from simulate threshold counts query
 */
interface SimulateThresholdCountsRow {
  actually_traded: number;
  would_trade: number;
}

/**
 * Row from model vs market query (with SQL-computed correlation)
 */
interface ModelVsMarketRow {
  symbol: string;
  avg_model_prob: number;
  avg_market_price_yes: number;
  evaluation_count: number;
  correlation: number;
}

/**
 * Raw stats row from database queries (shared by symbol and regime stats)
 * Note: wins can be null when SUM() operates on zero matching rows
 */
interface StatsRow {
  total_trades: number;
  wins: number | null;
  win_rate: number | null;
  avg_pnl: number | null;
  total_pnl: number | null;
}

/**
 * Stats row with symbol identifier
 */
interface SymbolStatsRow extends StatsRow {
  symbol: string;
}

/**
 * Stats row with regime identifier
 */
interface RegimeStatsRow extends StatsRow {
  volatility_regime: string;
}

/**
 * Base statistics fields shared by symbol and regime stats
 */
interface BaseStats {
  totalTrades: number;
  wins: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

/**
 * Empty stats returned when no data exists
 */
const EMPTY_STATS: BaseStats = {
  totalTrades: 0,
  wins: 0,
  winRate: 0,
  avgPnl: 0,
  totalPnl: 0,
};

/**
 * Map raw stats row to base stats fields (shared logic for symbol/regime stats)
 * Returns zero values if row is undefined (no matching data)
 */
function mapBaseStats(row: StatsRow | undefined): BaseStats {
  if (!row) {
    return EMPTY_STATS;
  }
  return {
    totalTrades: row.total_trades,
    wins: row.wins ?? 0,
    winRate: (row.win_rate ?? 0) * 100, // ratio to percentage
    avgPnl: row.avg_pnl ?? 0,
    totalPnl: row.total_pnl ?? 0,
  };
}

// ============================================================================
// Export
// ============================================================================

export { TradeRepository as default };
