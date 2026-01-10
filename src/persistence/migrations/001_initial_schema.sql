-- Migration 001: Initial Schema
-- Creates the core tables for Crypto15ML trade persistence
-- Part of #25

-- ============================================================================
-- Schema Version Tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- ============================================================================
-- Main Trades Table (Tier 1-3 data)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trades (
    -- Primary Key
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- === TIER 1: Essential ===
    -- Trade Identity
    condition_id TEXT NOT NULL,          -- Polymarket condition ID
    slug TEXT NOT NULL,                  -- Market slug
    symbol TEXT NOT NULL,                -- BTC, ETH, SOL, XRP

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

    -- Constraints
    UNIQUE(condition_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(signal_timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_outcome ON trades(outcome);
CREATE INDEX IF NOT EXISTS idx_trades_state_minute ON trades(state_minute);
CREATE INDEX IF NOT EXISTS idx_trades_hour ON trades(hour_of_day);
CREATE INDEX IF NOT EXISTS idx_trades_volatility ON trades(volatility_regime);
CREATE INDEX IF NOT EXISTS idx_trades_pending ON trades(outcome) WHERE outcome IS NULL;

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_trades_symbol_timestamp ON trades(symbol, signal_timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_outcome ON trades(symbol, outcome) WHERE outcome IS NOT NULL;

-- ============================================================================
-- Trade Features Table (Normalized 17 features)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trade_features (
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

    -- Volume z-score: placeholder for future implementation
    -- TODO(#26): Implement volume_zscore_15m calculation when volume data is available
    volume_zscore_15m REAL DEFAULT 0,  -- Default 0 represents neutral z-score (at mean)

    FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_features_trade ON trade_features(trade_id);

-- ============================================================================
-- Trade Prices Table (Minute-level prices)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trade_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,

    minute_offset INTEGER NOT NULL,      -- 0-14, minute within window
    timestamp INTEGER NOT NULL,          -- Unix ms
    price REAL NOT NULL,                 -- Spot price at this minute

    FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE,
    UNIQUE(trade_id, minute_offset)
);

CREATE INDEX IF NOT EXISTS idx_prices_trade ON trade_prices(trade_id);

-- ============================================================================
-- Record Migration
-- ============================================================================

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial schema: trades, features, prices tables');
