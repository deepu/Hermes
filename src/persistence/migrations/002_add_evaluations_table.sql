-- Migration 002: Add Evaluations Table
-- Creates table for storing market evaluation data (48 evaluations/hour regardless of trade action)
-- Part of #36

-- ============================================================================
-- Evaluations Table
-- ============================================================================
-- Captures every model evaluation, including skipped opportunities.
-- Stores the full decision context for later analysis.

CREATE TABLE IF NOT EXISTS evaluations (
    -- Primary Key
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- === Identity ===
    condition_id TEXT NOT NULL,           -- Polymarket condition ID
    slug TEXT NOT NULL,                   -- Market slug
    symbol TEXT NOT NULL CHECK (symbol IN ('BTC', 'ETH', 'SOL', 'XRP')),

    -- === Timing ===
    timestamp INTEGER NOT NULL,           -- Unix ms when evaluation occurred
    state_minute INTEGER NOT NULL CHECK (state_minute >= 0 AND state_minute <= 14),

    -- === Model Output ===
    model_probability REAL NOT NULL CHECK (model_probability >= 0 AND model_probability <= 1),
    linear_combination REAL NOT NULL,     -- Z-score before sigmoid
    imputed_count INTEGER NOT NULL CHECK (imputed_count >= 0),

    -- === Market Context ===
    market_price_yes REAL NOT NULL CHECK (market_price_yes >= 0 AND market_price_yes <= 1),
    market_price_no REAL NOT NULL CHECK (market_price_no >= 0 AND market_price_no <= 1),

    -- === Decision ===
    decision TEXT NOT NULL CHECK (decision IN ('SKIP', 'YES', 'NO')),
    reason TEXT NOT NULL,                 -- Human-readable reason for decision

    -- === Features ===
    -- Store all 17 features as JSON for flexibility if features evolve
    features_json TEXT NOT NULL,

    -- === Metadata ===
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- ============================================================================
-- Indexes for Common Query Patterns
-- ============================================================================

-- Query evaluations by timestamp (time-series analysis)
CREATE INDEX IF NOT EXISTS idx_evaluations_timestamp ON evaluations(timestamp);

-- Query evaluations by symbol (per-asset analysis)
CREATE INDEX IF NOT EXISTS idx_evaluations_symbol ON evaluations(symbol);

-- Query evaluations by decision (filter to trades vs skips)
CREATE INDEX IF NOT EXISTS idx_evaluations_decision ON evaluations(decision);

-- Composite index for symbol + timestamp queries
CREATE INDEX IF NOT EXISTS idx_evaluations_symbol_timestamp ON evaluations(symbol, timestamp);

-- Composite index for decision + timestamp (find all trades in range)
CREATE INDEX IF NOT EXISTS idx_evaluations_decision_timestamp ON evaluations(decision, timestamp);

-- Query evaluations by condition ID (market-specific analysis)
CREATE INDEX IF NOT EXISTS idx_evaluations_condition_id ON evaluations(condition_id);

-- ============================================================================
-- Record Migration
-- ============================================================================

INSERT INTO schema_version (version, applied_at, description)
VALUES (2, strftime('%s', 'now') * 1000, 'Add evaluations table for diagnostic logging');
