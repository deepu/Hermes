# Trade Persistence Specification

> **Status:** Approved
> **Author:** Claude Code
> **Created:** 2026-01-10
> **Related Issue:** #12 (Crypto15ML Strategy)

---

## 1. Overview

### 1.1 Problem Statement

The Crypto15ML strategy currently tracks paper trades in-memory only. When the service restarts, all historical trade data is lost. This prevents:
- Post-hoc analysis of strategy performance
- Identification of regime-specific underperformance
- Calibration analysis (predicted vs actual probabilities)
- Feature importance validation against live data
- Debugging of specific losing trades

### 1.2 Solution

Implement persistent trade recording using SQLite with comprehensive data capture across three tiers:
- **Tier 1:** Essential trade data and full feature vectors
- **Tier 2:** Regime and timing analysis data
- **Tier 3:** Advanced debugging data including minute-level prices

### 1.3 Goals

1. Record every paper trade with sufficient data to reproduce the decision
2. Enable offline analysis matching backtest capabilities
3. Zero impact on trading latency (async writes)
4. Support querying patterns needed for strategy improvement

---

## 2. Data Model

### 2.1 Trade Record Schema

```sql
CREATE TABLE trades (
    -- Primary Key
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- === TIER 1: Essential ===
    -- Trade Identity
    condition_id TEXT NOT NULL,          -- Polymarket condition ID
    slug TEXT NOT NULL,                  -- Market slug
    symbol TEXT NOT NULL,                -- BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT

    -- Trade Details
    side TEXT NOT NULL,                  -- 'YES' or 'NO'
    entry_price REAL NOT NULL,           -- Entry price (0-1)
    position_size REAL NOT NULL,         -- Position size in USD
    signal_timestamp INTEGER NOT NULL,   -- Unix ms when signal generated

    -- Model Output
    probability REAL NOT NULL,           -- Model probability (0-1)
    linear_combination REAL NOT NULL,    -- Z-score before sigmoid
    imputed_count INTEGER NOT NULL,      -- Number of imputed features

    -- Outcome (filled on resolution)
    outcome TEXT,                        -- 'UP', 'DOWN', or NULL if pending
    is_win INTEGER,                      -- 1 = win, 0 = loss, NULL if pending
    pnl REAL,                            -- Realized P&L in USD
    resolution_timestamp INTEGER,        -- Unix ms when market resolved

    -- === TIER 2: Regime Analysis ===
    state_minute INTEGER NOT NULL,       -- 0-14, minute within window
    hour_of_day INTEGER NOT NULL,        -- 0-23 UTC
    day_of_week INTEGER NOT NULL,        -- 0=Sunday, 6=Saturday
    volatility_regime TEXT,              -- 'low', 'mid', 'high'
    volatility_5m REAL,                  -- Raw volatility value

    -- Threshold Timing
    time_to_up_threshold INTEGER,        -- Minutes to hit up threshold (NULL if never)
    time_to_down_threshold INTEGER,      -- Minutes to hit down threshold

    -- Excursion Analysis
    max_favorable_excursion REAL,        -- Best price move in our favor
    max_adverse_excursion REAL,          -- Worst price move against us

    -- === TIER 3: Advanced ===
    window_open_price REAL,              -- Price at window start
    window_close_price REAL,             -- Price at window end
    entry_bid_price REAL,                -- Bid at entry (if available)
    entry_ask_price REAL,                -- Ask at entry (if available)

    -- Metadata
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER,

    -- Indexes for common queries
    UNIQUE(condition_id)
);

CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_timestamp ON trades(signal_timestamp);
CREATE INDEX idx_trades_outcome ON trades(outcome);
CREATE INDEX idx_trades_state_minute ON trades(state_minute);
CREATE INDEX idx_trades_hour ON trades(hour_of_day);
CREATE INDEX idx_trades_volatility ON trades(volatility_regime);
```

### 2.2 Features Table (Normalized)

```sql
CREATE TABLE trade_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,

    -- All 17 features from FeatureVector
    state_minute INTEGER NOT NULL,
    minutes_remaining INTEGER NOT NULL,
    hour_of_day INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,

    return_since_open REAL,
    max_run_up REAL,
    max_run_down REAL,
    return_1m REAL,
    return_3m REAL,
    return_5m REAL,

    volatility_5m REAL,

    has_up_hit INTEGER,                  -- Boolean as 0/1
    has_down_hit INTEGER,
    first_up_hit_minute REAL,            -- Can be NaN, stored as NULL
    first_down_hit_minute REAL,

    -- Volume (currently 0, reserved for future)
    volume_zscore_15m REAL DEFAULT 0,

    FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
);

CREATE INDEX idx_features_trade ON trade_features(trade_id);
```

### 2.3 Minute Prices Table

```sql
CREATE TABLE trade_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,

    minute_offset INTEGER NOT NULL,      -- 0-14, minute within window
    timestamp INTEGER NOT NULL,          -- Unix ms
    price REAL NOT NULL,                 -- Spot price at this minute

    FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE,
    UNIQUE(trade_id, minute_offset)
);

CREATE INDEX idx_prices_trade ON trade_prices(trade_id);
```

### 2.4 Volatility Regime Classification

```typescript
function classifyVolatilityRegime(volatility5m: number, symbol: string): 'low' | 'mid' | 'high' {
  // Thresholds calibrated from backtest data per symbol
  const thresholds: Record<string, { low: number; high: number }> = {
    BTCUSDT: { low: 0.0005, high: 0.0015 },
    ETHUSDT: { low: 0.0007, high: 0.0020 },
    SOLUSDT: { low: 0.0015, high: 0.0040 },
    XRPUSDT: { low: 0.0010, high: 0.0030 },
  };

  const t = thresholds[symbol] || { low: 0.001, high: 0.003 };

  if (volatility5m <= t.low) return 'low';
  if (volatility5m >= t.high) return 'high';
  return 'mid';
}
```

---

## 3. Implementation Design

### 3.1 New Files

```
src/
├── persistence/
│   ├── trade-repository.ts      # SQLite operations
│   ├── trade-repository.test.ts # Unit tests
│   └── migrations/
│       └── 001_initial_schema.sql
├── types/
│   └── trade-record.types.ts    # TypeScript interfaces
data/
└── crypto15ml/
    └── trades.db                # SQLite database file
```

### 3.2 TradeRepository Interface

```typescript
interface TradeRepository {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Write operations
  recordTrade(trade: TradeRecord): Promise<number>;  // Returns trade ID
  updateOutcome(conditionId: string, outcome: TradeOutcome): Promise<void>;
  recordMinutePrice(tradeId: number, minute: number, price: number, timestamp: number): Promise<void>;

  // Read operations
  getTradeByConditionId(conditionId: string): Promise<TradeRecord | null>;
  getPendingTrades(): Promise<TradeRecord[]>;

  // Analysis queries
  getTradesByDateRange(start: Date, end: Date): Promise<TradeRecord[]>;
  getTradesBySymbol(symbol: string): Promise<TradeRecord[]>;
  getPerformanceByRegime(regime: string): Promise<RegimeStats>;
  getCalibrationData(): Promise<CalibrationBucket[]>;

  // Maintenance
  vacuum(): Promise<void>;
  getStats(): Promise<DatabaseStats>;
}
```

### 3.3 TradeRecord Interface

```typescript
interface TradeRecord {
  // Identity
  id?: number;
  conditionId: string;
  slug: string;
  symbol: CryptoAsset;

  // Trade
  side: 'YES' | 'NO';
  entryPrice: number;
  positionSize: number;
  signalTimestamp: number;

  // Model
  probability: number;
  linearCombination: number;
  imputedCount: number;
  features: FeatureVector;

  // Outcome (optional until resolved)
  outcome?: 'UP' | 'DOWN';
  isWin?: boolean;
  pnl?: number;
  resolutionTimestamp?: number;

  // Regime
  stateMinute: number;
  hourOfDay: number;
  dayOfWeek: number;
  volatilityRegime: 'low' | 'mid' | 'high';
  volatility5m: number;

  // Timing
  timeToUpThreshold?: number;
  timeToDownThreshold?: number;

  // Excursion
  maxFavorableExcursion?: number;
  maxAdverseExcursion?: number;

  // Price context
  windowOpenPrice?: number;
  windowClosePrice?: number;
  entryBidPrice?: number;
  entryAskPrice?: number;

  // Minute prices
  minutePrices?: MinutePrice[];
}

interface MinutePrice {
  minuteOffset: number;  // 0-14
  timestamp: number;
  price: number;
}

interface TradeOutcome {
  outcome: 'UP' | 'DOWN';
  isWin: boolean;
  pnl: number;
  resolutionTimestamp: number;
  windowClosePrice: number;
  timeToUpThreshold?: number;
  timeToDownThreshold?: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
}
```

### 3.4 Integration Points

#### In `Crypto15MLStrategyService`:

```typescript
class Crypto15MLStrategyService {
  private tradeRepository?: TradeRepository;

  constructor(
    // ... existing params
    config: Crypto15MLConfig,
    tradeRepository?: TradeRepository  // Optional dependency injection
  ) {
    // ...
  }

  // Modify recordPaperPosition to persist
  private async recordPaperPosition(signal: Signal): Promise<void> {
    // Existing in-memory tracking...

    // NEW: Persist to database
    if (this.tradeRepository) {
      const tradeRecord = this.signalToTradeRecord(signal);
      const tradeId = await this.tradeRepository.recordTrade(tradeRecord);

      // Store tradeId for later updates
      this.tradeIdMap.set(signal.conditionId, tradeId);
    }
  }

  // Modify handleMarketResolution to update outcome
  private async handleMarketResolution(
    conditionId: string,
    outcome: 'UP' | 'DOWN'
  ): Promise<void> {
    // Existing P&L calculation...

    // NEW: Update database
    if (this.tradeRepository) {
      await this.tradeRepository.updateOutcome(conditionId, {
        outcome,
        isWin,
        pnl,
        resolutionTimestamp: Date.now(),
        windowClosePrice: this.getLatestPrice(symbol),
        maxFavorableExcursion: this.calculateMFE(tracker),
        maxAdverseExcursion: this.calculateMAE(tracker),
        // ... timing data
      });
    }
  }
}
```

#### Price Tracking During Window:

```typescript
// In MarketTracker or FeatureEngine
private recordMinutePrices(tradeId: number, prices: PriceRecord[]): void {
  // Called at each minute boundary during the window
  // Stores prices for post-hoc analysis
}
```

### 3.5 Configuration

```typescript
interface Crypto15MLConfig {
  // ... existing config

  // NEW: Persistence options
  persistence?: {
    enabled: boolean;           // Default: true
    dbPath: string;             // Default: './data/crypto15ml/trades.db'
    syncMode: 'async' | 'sync'; // Default: 'async' (non-blocking writes)
    vacuumIntervalHours: number; // Default: 24
  };
}
```

Environment variables:
```bash
CRYPTO15ML_PERSISTENCE_ENABLED=true
CRYPTO15ML_PERSISTENCE_DB_PATH=./data/crypto15ml/trades.db
```

---

## 4. Analysis Queries

### 4.1 Performance by Symbol

```sql
SELECT
  symbol,
  COUNT(*) as total_trades,
  SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
  ROUND(AVG(is_win) * 100, 2) as win_rate,
  ROUND(SUM(pnl), 2) as total_pnl,
  ROUND(AVG(pnl), 2) as avg_pnl
FROM trades
WHERE outcome IS NOT NULL
GROUP BY symbol;
```

### 4.2 Performance by Regime

```sql
SELECT
  volatility_regime,
  COUNT(*) as trades,
  ROUND(AVG(is_win) * 100, 2) as win_rate,
  ROUND(AVG(pnl), 2) as avg_pnl
FROM trades
WHERE outcome IS NOT NULL
GROUP BY volatility_regime;
```

### 4.3 Calibration Analysis

```sql
-- Bucket predictions and compare to actual win rate
SELECT
  CASE
    WHEN probability >= 0.75 THEN '0.75+'
    WHEN probability >= 0.70 THEN '0.70-0.75'
    WHEN probability <= 0.25 THEN '0.25-'
    WHEN probability <= 0.30 THEN '0.25-0.30'
    ELSE 'middle'
  END as prob_bucket,
  COUNT(*) as trades,
  ROUND(AVG(probability), 3) as avg_predicted,
  ROUND(AVG(is_win), 3) as actual_win_rate,
  ROUND(AVG(is_win) - AVG(probability), 3) as calibration_gap
FROM trades
WHERE outcome IS NOT NULL AND side = 'YES'
GROUP BY prob_bucket;
```

### 4.4 Time-of-Day Analysis

```sql
SELECT
  hour_of_day,
  COUNT(*) as trades,
  ROUND(AVG(is_win) * 100, 2) as win_rate,
  ROUND(SUM(pnl), 2) as total_pnl
FROM trades
WHERE outcome IS NOT NULL
GROUP BY hour_of_day
ORDER BY hour_of_day;
```

### 4.5 State Minute Analysis

```sql
SELECT
  state_minute,
  COUNT(*) as trades,
  ROUND(AVG(is_win) * 100, 2) as win_rate,
  ROUND(AVG(probability), 3) as avg_confidence
FROM trades
WHERE outcome IS NOT NULL
GROUP BY state_minute
ORDER BY state_minute;
```

### 4.6 Feature Correlation with Wins

```sql
SELECT
  ROUND(AVG(CASE WHEN is_win = 1 THEN f.return_since_open END), 6) as win_avg_return,
  ROUND(AVG(CASE WHEN is_win = 0 THEN f.return_since_open END), 6) as loss_avg_return,
  ROUND(AVG(CASE WHEN is_win = 1 THEN f.volatility_5m END), 6) as win_avg_vol,
  ROUND(AVG(CASE WHEN is_win = 0 THEN f.volatility_5m END), 6) as loss_avg_vol
FROM trades t
JOIN trade_features f ON t.id = f.trade_id
WHERE t.outcome IS NOT NULL;
```

---

## 5. Migration Strategy

### 5.1 Schema Versioning

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
```

### 5.2 Migration Runner

```typescript
async function runMigrations(db: Database): Promise<void> {
  const currentVersion = await getCurrentVersion(db);
  const migrations = await loadMigrations();

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      await db.exec(migration.sql);
      await recordMigration(db, migration.version, migration.description);
    }
  }
}
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

- `TradeRepository` CRUD operations
- Schema migrations
- Query correctness
- Edge cases (NaN features, missing data)

### 6.2 Integration Tests

- Full flow: signal -> record -> resolve -> query
- Concurrent writes
- Database recovery after crash
- Performance under load

### 6.3 Test Data

```typescript
const testTrade: TradeRecord = {
  conditionId: 'test-cond-123',
  slug: 'btc-updown-15m-test',
  symbol: 'BTC',
  side: 'YES',
  entryPrice: 0.65,
  positionSize: 100,
  signalTimestamp: Date.now(),
  probability: 0.72,
  linearCombination: 0.94,
  imputedCount: 0,
  features: { /* ... */ },
  stateMinute: 1,
  hourOfDay: 14,
  dayOfWeek: 3,
  volatilityRegime: 'mid',
  volatility5m: 0.0012,
};
```

---

## 7. Operational Considerations

### 7.1 Database Location

- **Development:** `./data/crypto15ml/trades.db`
- **Railway:** Persistent volume at `/data/crypto15ml/trades.db`

### 7.2 Backup Strategy

```bash
# Daily backup via cron or Railway scheduled job
sqlite3 /data/crypto15ml/trades.db ".backup /backups/trades-$(date +%Y%m%d).db"
```

### 7.3 Database Size Estimates

| Timeframe | Trades | DB Size (est.) |
|-----------|--------|----------------|
| 1 day | ~250 | ~500 KB |
| 1 week | ~1,750 | ~3.5 MB |
| 1 month | ~7,500 | ~15 MB |
| 1 year | ~90,000 | ~180 MB |

### 7.4 Performance

- Writes are async (non-blocking to trading)
- Reads use indexes for common query patterns
- Vacuum runs daily during low-activity periods

---

## 8. Implementation Plan

### Phase 1: Core Repository (2-3 hours)
1. Create `src/persistence/trade-repository.ts`
2. Implement SQLite connection and migrations
3. Implement `recordTrade()` and `updateOutcome()`
4. Unit tests

### Phase 2: Integration (2-3 hours)
1. Add `TradeRepository` to `Crypto15MLStrategyService`
2. Modify `recordPaperPosition()` to persist
3. Modify `handleMarketResolution()` to update outcome
4. Integration tests

### Phase 3: Price Tracking (1-2 hours)
1. Add minute price recording to feature engine
2. Store prices during window lifecycle
3. Calculate MFE/MAE on resolution

### Phase 4: Analysis Tooling (1-2 hours)
1. Create analysis query helpers
2. Add CLI commands for common queries
3. Document query patterns

---

## 9. Success Criteria

- [ ] All paper trades persisted to SQLite
- [ ] Full feature vectors recorded for each trade
- [ ] Minute-level prices captured during window
- [ ] Outcomes updated on market resolution
- [ ] Zero impact on trading latency
- [ ] Analysis queries return correct results
- [ ] Database survives service restarts
- [ ] Backups automated on Railway

---

## 10. Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage backend | SQLite | Simple, no infrastructure, portable |
| Price granularity | Minute-level | Balance of detail vs storage |
| Data tiers | All 3 tiers | Maximum analysis capability |
| Export format | None (SQLite direct) | Can query directly or copy .db file |

---

## Appendix A: File Locations

| File | Purpose |
|------|---------|
| `src/persistence/trade-repository.ts` | SQLite operations |
| `src/persistence/migrations/*.sql` | Schema migrations |
| `src/types/trade-record.types.ts` | TypeScript interfaces |
| `data/crypto15ml/trades.db` | SQLite database |
| `docs/crypto15ml/TRADE_PERSISTENCE.md` | User documentation |

## Appendix B: Dependencies

```json
{
  "better-sqlite3": "^11.0.0"
}
```

Note: Using `better-sqlite3` (synchronous) over `sql.js` for better performance. Async writes handled via worker thread or setImmediate.
