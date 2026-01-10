-- Analysis Queries for Crypto15ML Trade Persistence
-- Reference SQL for direct SQLite access
-- Part of #29
--
-- Database file: ./data/crypto15ml/trades.db
-- Connect: sqlite3 ./data/crypto15ml/trades.db
--
-- These queries match the TradeRepository TypeScript methods.
-- For ad-hoc analysis beyond these, write custom SQL directly.

-- ============================================================================
-- BASIC QUERIES (Implemented in TradeRepository)
-- ============================================================================

-- Get all pending (unresolved) trades
-- Method: getPendingTrades()
SELECT * FROM trades
WHERE outcome IS NULL
ORDER BY signal_timestamp ASC;

-- Get trade by condition ID
-- Method: getTradeByConditionId(conditionId)
SELECT * FROM trades WHERE condition_id = ?;

-- Get trades within date range (timestamps in Unix ms)
-- Method: getTradesByDateRange(start, end)
SELECT * FROM trades
WHERE signal_timestamp >= ? AND signal_timestamp <= ?
ORDER BY signal_timestamp ASC;

-- Get trades for a specific symbol
-- Method: getTradesBySymbol(symbol)
SELECT * FROM trades WHERE symbol = ? ORDER BY signal_timestamp ASC;

-- ============================================================================
-- PERFORMANCE BY SYMBOL (Implemented in TradeRepository)
-- ============================================================================

-- Statistics for a single symbol
-- Method: getSymbolStats(symbol)
SELECT
    COUNT(*) as total_trades,
    SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
    AVG(is_win) as win_rate,
    AVG(pnl) as avg_pnl,
    SUM(pnl) as total_pnl
FROM trades
WHERE symbol = ? AND outcome IS NOT NULL;

-- Statistics for all symbols
-- Method: getAllSymbolStats()
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
ORDER BY total_trades DESC;

-- ============================================================================
-- PERFORMANCE BY VOLATILITY REGIME (Implemented in TradeRepository)
-- ============================================================================

-- Statistics for a single regime
-- Method: getPerformanceByRegime(regime)
SELECT
    COUNT(*) as total_trades,
    SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
    AVG(is_win) as win_rate,
    AVG(pnl) as avg_pnl,
    SUM(pnl) as total_pnl
FROM trades
WHERE volatility_regime = ? AND outcome IS NOT NULL;

-- Statistics for all regimes
-- Method: getAllRegimeStats()
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
ORDER BY total_trades DESC;

-- ============================================================================
-- CALIBRATION ANALYSIS (Implemented in TradeRepository)
-- ============================================================================

-- Calibration by probability bucket (YES trades only)
-- Method: getCalibrationData()
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
ORDER BY avg_predicted DESC;

-- ============================================================================
-- DATABASE STATISTICS (Implemented in TradeRepository)
-- ============================================================================

-- Overall statistics
-- Method: getStats()
SELECT
    COUNT(*) as total_trades,
    SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved,
    MIN(signal_timestamp) as oldest_trade,
    MAX(signal_timestamp) as newest_trade
FROM trades;
