#!/usr/bin/env npx tsx
/**
 * Crypto15ML Strategy Runner
 *
 * Main entry point for running the Crypto15ML strategy in production.
 * Designed for Railway deployment with structured JSON logging.
 *
 * Usage:
 *   npx tsx scripts/crypto15ml/run-strategy.ts
 *
 * Environment Variables:
 *   POLYMARKET_PRIVATE_KEY - Wallet private key (required)
 *   CRYPTO15ML_ENABLED - Enable strategy (default: true)
 *   CRYPTO15ML_DRY_RUN - Paper trading mode (default: true)
 *   CRYPTO15ML_POSITION_SIZE - Position size in USD (default: 100)
 *   CRYPTO15ML_MODEL_PATH - Path to model file (default: ./models/crypto15ml_model.json)
 *   CRYPTO15ML_IMPUTATION_PATH - Path to imputation file (default: ./models/crypto15ml_imputations.json)
 *   CRYPTO15ML_YES_THRESHOLD - YES signal threshold (default: 0.70)
 *   CRYPTO15ML_NO_THRESHOLD - NO signal threshold (default: 0.30)
 *   CRYPTO15ML_ENTRY_PRICE_CAP - Max entry price (default: 0.70)
 *   CRYPTO15ML_DEBUG - Enable debug logging (default: false)
 *
 * Part of #11
 */

import { PolymarketSDK } from '../../src/index.js';
import { Crypto15MLStrategyService } from '../../src/services/crypto15-ml-strategy-service.js';
import type { Crypto15MLConfig } from '../../src/services/crypto15-ml-strategy-service.js';

// ============================================================================
// Configuration
// ============================================================================

function loadConfig(): Crypto15MLConfig {
  const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
  };

  const parseNumber = (value: string | undefined, defaultValue: number): number => {
    if (value === undefined) return defaultValue;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  };

  return {
    enabled: parseBoolean(process.env.CRYPTO15ML_ENABLED, true),
    dryRun: parseBoolean(process.env.CRYPTO15ML_DRY_RUN, true),
    debug: parseBoolean(process.env.CRYPTO15ML_DEBUG, false),
    modelPath: process.env.CRYPTO15ML_MODEL_PATH || './models/crypto15ml_model.json',
    imputationPath: process.env.CRYPTO15ML_IMPUTATION_PATH || './models/crypto15ml_imputations.json',
    positionSizeUsd: parseNumber(process.env.CRYPTO15ML_POSITION_SIZE, 100),
    yesThreshold: parseNumber(process.env.CRYPTO15ML_YES_THRESHOLD, 0.70),
    noThreshold: parseNumber(process.env.CRYPTO15ML_NO_THRESHOLD, 0.30),
    entryPriceCap: parseNumber(process.env.CRYPTO15ML_ENTRY_PRICE_CAP, 0.70),
    stateMinutes: [0, 1, 2],
    horizonMinutes: 15,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
    thresholdBps: {
      BTC: 0.0008,  // 8 bps
      ETH: 0.0010,  // 10 bps
      SOL: 0.0020,  // 20 bps
      XRP: 0.0015,  // 15 bps
    },
  };
}

// ============================================================================
// Logging
// ============================================================================

interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  event: string;
  message?: string;
  [key: string]: unknown;
}

function log(level: LogEntry['level'], event: string, data: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    _service: 'hermes',
    _app: 'crypto15ml',
    _env: process.env.NODE_ENV || 'development',
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  log('INFO', 'startup', { message: 'Crypto15ML Strategy starting...' });

  // Validate environment
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    log('ERROR', 'config_error', { message: 'POLYMARKET_PRIVATE_KEY is required' });
    process.exit(1);
  }

  // Load configuration
  const config = loadConfig();
  log('INFO', 'config_loaded', {
    enabled: config.enabled,
    dryRun: config.dryRun,
    positionSizeUsd: config.positionSizeUsd,
    yesThreshold: config.yesThreshold,
    noThreshold: config.noThreshold,
    entryPriceCap: config.entryPriceCap,
    modelPath: config.modelPath,
    imputationPath: config.imputationPath,
  });

  if (!config.enabled) {
    log('WARN', 'strategy_disabled', { message: 'Strategy is disabled via CRYPTO15ML_ENABLED=false' });
    // Keep process alive but idle
    await new Promise(() => {});
  }

  // Initialize SDK
  log('INFO', 'sdk_initializing', { message: 'Initializing PolymarketSDK...' });
  const sdk = await PolymarketSDK.create({ privateKey });
  log('INFO', 'sdk_initialized', { message: 'SDK initialized successfully' });

  // Create strategy service
  const strategy = new Crypto15MLStrategyService(
    sdk.markets,
    sdk.tradingService,
    sdk.realtime,
    config
  );

  // Attach event handlers
  strategy.on('signal', (signal) => {
    log('INFO', 'signal_generated', {
      conditionId: signal.conditionId,
      slug: signal.slug,
      asset: signal.asset,
      side: signal.side,
      probability: signal.probability,
      entryPrice: signal.entryPrice,
      stateMinute: signal.stateMinute,
    });
  });

  strategy.on('execution', (result) => {
    log('INFO', 'execution_result', {
      conditionId: result.signal.conditionId,
      side: result.signal.side,
      asset: result.signal.asset,
      success: result.orderResult.success,
      error: result.orderResult.error,
    });
  });

  strategy.on('paperPosition', (position) => {
    log('INFO', 'paper_position', {
      marketId: position.marketId,
      slug: position.slug,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      size: position.size,
      confidence: position.confidence,
    });
  });

  strategy.on('paperSettlement', (result) => {
    log('INFO', 'paper_settlement', {
      marketId: result.position.marketId,
      symbol: result.position.symbol,
      side: result.position.side,
      outcome: result.outcome,
      pnl: result.pnl,
    });
  });

  strategy.on('error', (error) => {
    log('ERROR', 'strategy_error', {
      message: error.message,
      stack: error.stack,
    });
  });

  // Start strategy
  log('INFO', 'strategy_starting', { message: 'Starting Crypto15ML strategy...' });
  await strategy.start();
  log('INFO', 'strategy_started', {
    message: 'Strategy started successfully',
    dryRun: config.dryRun,
    trackerCount: strategy.getTrackerCount(),
  });

  // Handle shutdown signals
  const shutdown = async (signal: string): Promise<void> => {
    log('INFO', 'shutdown_initiated', { signal });

    // Log final stats if in dry-run mode
    if (config.dryRun) {
      const stats = strategy.getPaperTradingStats();
      log('INFO', 'final_stats', {
        positionCount: stats.positionCount,
        cumulativePnL: stats.cumulativePnL,
        winRate: stats.winRate,
        averagePnL: stats.averagePnL,
      });
    }

    strategy.stop();
    sdk.stop();
    log('INFO', 'shutdown_complete', { message: 'Shutdown complete' });
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep alive
  log('INFO', 'running', { message: 'Strategy is running. Press Ctrl+C to stop.' });
}

main().catch((error) => {
  log('ERROR', 'fatal_error', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
