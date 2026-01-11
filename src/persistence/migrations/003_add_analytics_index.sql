-- Migration 003: Add Analytics Index
-- Adds composite index for efficient threshold simulation queries
-- Part of #38

-- ============================================================================
-- Index for Analytics Queries
-- ============================================================================
-- Supports queries that filter by timestamp range and model_probability threshold
-- Used by: simulateThreshold, getProbabilityDistribution

CREATE INDEX IF NOT EXISTS idx_evaluations_timestamp_probability
  ON evaluations(timestamp, model_probability);

-- ============================================================================
-- Record Migration
-- ============================================================================

INSERT INTO schema_version (version, applied_at, description)
VALUES (3, strftime('%s', 'now') * 1000, 'Add composite index for evaluation analytics');
