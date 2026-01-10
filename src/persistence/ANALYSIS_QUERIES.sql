-- Analysis Queries for Crypto15ML Trade Persistence
-- Reference SQL for direct SQLite access
-- Part of #29
--
-- Database file: ./data/crypto15ml/trades.db
-- Connect: sqlite3 ./data/crypto15ml/trades.db
--
-- These queries can be run directly against the database for ad-hoc analysis.
-- The TradeRepository class provides TypeScript wrappers for common operations.

-- ============================================================================
-- BASIC QUERIES
-- ============================================================================

-- Get all pending (unresolved) trades
SELECT * FROM trades
WHERE outcome IS NULL
ORDER BY signal_timestamp ASC;

-- Get trade by condition ID
SELECT * FROM trades WHERE condition_id = ?;

-- Get trades within date range (timestamps in Unix ms)
SELECT * FROM trades
WHERE signal_timestamp >= ? AND signal_timestamp <= ?
ORDER BY signal_timestamp ASC;

-- Get trades for a specific symbol
SELECT * FROM trades WHERE symbol = ? ORDER BY signal_timestamp ASC;

-- ============================================================================
-- PERFORMANCE BY SYMBOL
-- ============================================================================

-- Statistics for a single symbol
SELECT
    symbol,
    COUNT(*) as total_trades,
    SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl,
    ROUND(AVG(pnl), 2) as avg_pnl
FROM trades
WHERE symbol = 'BTC' AND outcome IS NOT NULL
GROUP BY symbol;

-- Statistics for all symbols
SELECT
    symbol,
    COUNT(*) as total_trades,
    SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl,
    ROUND(AVG(pnl), 2) as avg_pnl
FROM trades
WHERE outcome IS NOT NULL
GROUP BY symbol
ORDER BY total_trades DESC;

-- ============================================================================
-- PERFORMANCE BY VOLATILITY REGIME
-- ============================================================================

-- Statistics for a single regime
SELECT
    volatility_regime,
    COUNT(*) as total_trades,
    SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl,
    ROUND(AVG(pnl), 2) as avg_pnl
FROM trades
WHERE volatility_regime = 'mid' AND outcome IS NOT NULL
GROUP BY volatility_regime;

-- Statistics for all regimes
SELECT
    volatility_regime,
    COUNT(*) as total_trades,
    SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl,
    ROUND(AVG(pnl), 2) as avg_pnl
FROM trades
WHERE outcome IS NOT NULL AND volatility_regime IS NOT NULL
GROUP BY volatility_regime
ORDER BY total_trades DESC;

-- ============================================================================
-- CALIBRATION ANALYSIS
-- ============================================================================

-- Calibration by probability bucket (YES trades only)
-- Compares predicted probability vs actual win rate
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
    END as prob_bucket,
    COUNT(*) as trades,
    ROUND(AVG(probability), 3) as avg_predicted,
    ROUND(AVG(is_win), 3) as actual_win_rate,
    ROUND(AVG(is_win) - AVG(probability), 3) as calibration_gap
FROM trades
WHERE outcome IS NOT NULL AND side = 'YES'
GROUP BY prob_bucket
ORDER BY avg_predicted DESC;

-- ============================================================================
-- TIME-OF-DAY ANALYSIS
-- ============================================================================

-- Performance by hour of day
SELECT
    hour_of_day,
    COUNT(*) as trades,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl
FROM trades
WHERE outcome IS NOT NULL
GROUP BY hour_of_day
ORDER BY hour_of_day;

-- Performance by day of week (0=Sunday, 6=Saturday)
SELECT
    day_of_week,
    CASE day_of_week
        WHEN 0 THEN 'Sunday'
        WHEN 1 THEN 'Monday'
        WHEN 2 THEN 'Tuesday'
        WHEN 3 THEN 'Wednesday'
        WHEN 4 THEN 'Thursday'
        WHEN 5 THEN 'Friday'
        WHEN 6 THEN 'Saturday'
    END as day_name,
    COUNT(*) as trades,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl
FROM trades
WHERE outcome IS NOT NULL
GROUP BY day_of_week
ORDER BY day_of_week;

-- ============================================================================
-- STATE MINUTE ANALYSIS
-- ============================================================================

-- Performance by minute within window (0-14)
SELECT
    state_minute,
    COUNT(*) as trades,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(AVG(probability), 3) as avg_confidence,
    ROUND(SUM(pnl), 2) as total_pnl
FROM trades
WHERE outcome IS NOT NULL
GROUP BY state_minute
ORDER BY state_minute;

-- ============================================================================
-- EXCURSION ANALYSIS
-- ============================================================================

-- Average max favorable/adverse excursion by outcome
SELECT
    outcome,
    COUNT(*) as trades,
    ROUND(AVG(max_favorable_excursion), 4) as avg_mfe,
    ROUND(AVG(max_adverse_excursion), 4) as avg_mae,
    ROUND(MIN(max_adverse_excursion), 4) as worst_mae
FROM trades
WHERE outcome IS NOT NULL
GROUP BY outcome;

-- Threshold timing analysis
SELECT
    outcome,
    COUNT(*) as total_trades,
    SUM(CASE WHEN time_to_up_threshold IS NOT NULL THEN 1 ELSE 0 END) as hit_up,
    SUM(CASE WHEN time_to_down_threshold IS NOT NULL THEN 1 ELSE 0 END) as hit_down,
    ROUND(AVG(time_to_up_threshold), 1) as avg_time_up,
    ROUND(AVG(time_to_down_threshold), 1) as avg_time_down
FROM trades
WHERE outcome IS NOT NULL
GROUP BY outcome;

-- ============================================================================
-- DATABASE STATISTICS
-- ============================================================================

-- Overall statistics
SELECT
    COUNT(*) as total_trades,
    SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved,
    MIN(signal_timestamp) as oldest_trade,
    MAX(signal_timestamp) as newest_trade
FROM trades;

-- Database size (run these as separate statements)
-- SELECT page_count * page_size as db_size_bytes FROM pragma_page_count(), pragma_page_size();

-- Or use file system:
-- ls -lh ./data/crypto15ml/trades.db

-- ============================================================================
-- MINUTE PRICE ANALYSIS
-- ============================================================================

-- Price trajectory for a specific trade
SELECT
    tp.minute_offset,
    tp.timestamp,
    tp.price,
    t.window_open_price,
    ROUND((tp.price - t.window_open_price) / t.window_open_price * 100, 4) as return_pct
FROM trade_prices tp
JOIN trades t ON t.id = tp.trade_id
WHERE t.condition_id = ?
ORDER BY tp.minute_offset;

-- Average price returns by minute offset
SELECT
    tp.minute_offset,
    COUNT(*) as samples,
    ROUND(AVG((tp.price - t.window_open_price) / t.window_open_price * 100), 4) as avg_return_pct
FROM trade_prices tp
JOIN trades t ON t.id = tp.trade_id
WHERE t.outcome IS NOT NULL
GROUP BY tp.minute_offset
ORDER BY tp.minute_offset;

-- ============================================================================
-- FEATURE ANALYSIS
-- ============================================================================

-- Get features for a specific trade
SELECT * FROM trade_features WHERE trade_id = ?;

-- Average feature values by outcome
SELECT
    t.outcome,
    COUNT(*) as trades,
    ROUND(AVG(tf.return_since_open), 6) as avg_return_since_open,
    ROUND(AVG(tf.max_run_up), 6) as avg_run_up,
    ROUND(AVG(tf.max_run_down), 6) as avg_run_down,
    ROUND(AVG(tf.volatility_5m), 6) as avg_vol_5m,
    ROUND(AVG(tf.return_1m), 6) as avg_return_1m,
    ROUND(AVG(tf.return_5m), 6) as avg_return_5m
FROM trades t
JOIN trade_features tf ON tf.trade_id = t.id
WHERE t.outcome IS NOT NULL
GROUP BY t.outcome;

-- ============================================================================
-- COMBINED ANALYSIS
-- ============================================================================

-- Symbol + Regime performance matrix
SELECT
    symbol,
    volatility_regime,
    COUNT(*) as trades,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl
FROM trades
WHERE outcome IS NOT NULL AND volatility_regime IS NOT NULL
GROUP BY symbol, volatility_regime
ORDER BY symbol, volatility_regime;

-- Recent performance (last 7 days)
SELECT
    symbol,
    COUNT(*) as trades,
    ROUND(AVG(is_win) * 100, 2) as win_rate_pct,
    ROUND(SUM(pnl), 2) as total_pnl
FROM trades
WHERE outcome IS NOT NULL
  AND signal_timestamp >= (strftime('%s', 'now') * 1000 - 7 * 24 * 60 * 60 * 1000)
GROUP BY symbol
ORDER BY total_pnl DESC;
