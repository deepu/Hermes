/**
 * Crypto15ML Strategy Configuration
 *
 * Configuration file for the 15-minute binary crypto market ML strategy.
 * All values can be overridden via environment variables.
 *
 * Part of #10
 */

import type { Crypto15MLConfig } from '../src/types/crypto15ml.types.js';
import type { PersistenceConfig } from '../src/types/trade-record.types.js';

/**
 * Default configuration for Crypto15ML strategy
 *
 * Environment variables:
 * - CRYPTO15ML_ENABLED: Enable/disable the strategy (default: false)
 * - CRYPTO15ML_DRY_RUN: Enable dry-run mode for paper trading (default: true)
 * - CRYPTO15ML_MODEL_PATH: Path to model JSON file
 * - CRYPTO15ML_IMPUTATION_PATH: Path to imputation JSON file
 * - CRYPTO15ML_POSITION_SIZE: Position size in USD (default: 100)
 * - CRYPTO15ML_YES_THRESHOLD: Probability threshold for YES signal (default: 0.70)
 * - CRYPTO15ML_NO_THRESHOLD: Probability threshold for NO signal (default: 0.30)
 * - CRYPTO15ML_ENTRY_PRICE_CAP: Maximum entry price (default: 0.70)
 * - CRYPTO15ML_DEBUG: Enable debug logging (default: false)
 * - CRYPTO15ML_PERSISTENCE_ENABLED: Enable trade persistence (default: true)
 * - CRYPTO15ML_PERSISTENCE_DB_PATH: Database file path (default: './data/crypto15ml/trades.db')
 * - CRYPTO15ML_PERSISTENCE_SYNC_MODE: Write mode 'async' or 'sync' (default: 'async')
 * - CRYPTO15ML_PERSISTENCE_VACUUM_INTERVAL: Hours between vacuum operations (default: 24)
 */
export const crypto15mlConfig: Crypto15MLConfig = {
  // === Strategy Toggle ===
  // Set to true to enable the strategy
  enabled: process.env.CRYPTO15ML_ENABLED === 'true',

  // === Model Paths ===
  // Paths to the trained model and imputation files
  modelPath: process.env.CRYPTO15ML_MODEL_PATH || './models/crypto15ml_model.json',
  imputationPath: process.env.CRYPTO15ML_IMPUTATION_PATH || './models/crypto15ml_imputations.json',

  // === Dry Run Mode ===
  // When true, signals are generated but no real trades are executed
  // Use for testing and validation before going live
  dryRun: process.env.CRYPTO15ML_DRY_RUN !== 'false', // Default: true

  // === Time Windows ===
  // State minutes when signals can be generated (0-14)
  // Early minutes (0-2) have highest predictive value
  stateMinutes: [0, 1, 2],

  // Prediction horizon in minutes (matches market duration)
  horizonMinutes: 15,

  // === Signal Thresholds ===
  // Probability thresholds for generating signals
  // YES signal: probability >= yesThreshold
  // NO signal: probability <= noThreshold
  yesThreshold: parseFloat(process.env.CRYPTO15ML_YES_THRESHOLD || '0.70'),
  noThreshold: parseFloat(process.env.CRYPTO15ML_NO_THRESHOLD || '0.30'),

  // Maximum acceptable entry price (0-1)
  // Trades with entry price > entryPriceCap are rejected
  entryPriceCap: parseFloat(process.env.CRYPTO15ML_ENTRY_PRICE_CAP || '0.70'),

  // === Position Sizing ===
  // Size of each position in USD
  positionSizeUsd: parseFloat(process.env.CRYPTO15ML_POSITION_SIZE || '100'),

  // === Symbols ===
  // Binance symbols to track for the strategy
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],

  // === Threshold BPS ===
  // Basis points threshold for up/down detection per asset
  // Used by the feature engine to detect threshold hits
  thresholdBps: {
    BTC: 0.0008, // 8 bps for BTC
    ETH: 0.0010, // 10 bps for ETH
    SOL: 0.0020, // 20 bps for SOL
    XRP: 0.0015, // 15 bps for XRP
  },

  // === Debug Mode ===
  // Enable debug logging for development
  debug: process.env.CRYPTO15ML_DEBUG === 'true',

  // === Persistence Configuration ===
  // SQLite persistence for paper trade recording
  persistence: {
    enabled: process.env.CRYPTO15ML_PERSISTENCE_ENABLED !== 'false', // Default: true
    dbPath: process.env.CRYPTO15ML_PERSISTENCE_DB_PATH || './data/crypto15ml/trades.db',
    syncMode: (process.env.CRYPTO15ML_PERSISTENCE_SYNC_MODE as PersistenceConfig['syncMode']) || 'async',
    vacuumIntervalHours: parseInt(process.env.CRYPTO15ML_PERSISTENCE_VACUUM_INTERVAL || '24', 10),
  },
};

/**
 * Validate configuration and log any issues
 */
export function validateCrypto15MLConfig(config: Crypto15MLConfig): string[] {
  const issues: string[] = [];

  if (config.positionSizeUsd <= 0) {
    issues.push('positionSizeUsd must be positive');
  }

  if (config.yesThreshold < 0 || config.yesThreshold > 1) {
    issues.push('yesThreshold must be between 0 and 1');
  }

  if (config.noThreshold < 0 || config.noThreshold > 1) {
    issues.push('noThreshold must be between 0 and 1');
  }

  if (config.noThreshold >= config.yesThreshold) {
    issues.push('noThreshold must be less than yesThreshold');
  }

  if (config.entryPriceCap < 0 || config.entryPriceCap > 1) {
    issues.push('entryPriceCap must be between 0 and 1');
  }

  if (config.stateMinutes.some((m) => m < 0 || m > 14)) {
    issues.push('stateMinutes values must be between 0 and 14');
  }

  if (config.symbols.length === 0) {
    issues.push('symbols array cannot be empty');
  }

  return issues;
}

export default crypto15mlConfig;
