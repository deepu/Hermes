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
 *   CRYPTO15ML_SYMBOLS - Comma-separated symbols (default: BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT)
 *   CRYPTO15ML_HORIZON_MINUTES - Horizon in minutes (default: 15)
 *   CRYPTO15ML_THRESHOLD_BTC - BTC threshold in bps (default: 0.0008)
 *   CRYPTO15ML_THRESHOLD_ETH - ETH threshold in bps (default: 0.0010)
 *   CRYPTO15ML_THRESHOLD_SOL - SOL threshold in bps (default: 0.0020)
 *   CRYPTO15ML_THRESHOLD_XRP - XRP threshold in bps (default: 0.0015)
 *
 * Part of #11
 */

import { PolymarketSDK } from '../../src/index.js';
import { Crypto15MLStrategyService } from '../../src/services/crypto15-ml-strategy-service.js';
import type { Crypto15MLConfig } from '../../src/services/crypto15-ml-strategy-service.js';
import {
  createCrypto15MLLogger,
  LogEvents,
  type IStrategyLogger,
} from '../../src/utils/strategy-logger.js';

// ============================================================================
// Configuration
// ============================================================================

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseStringArray(value: string | undefined, defaultValue: string[]): string[] {
  if (value === undefined) return defaultValue;
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function loadConfig(): Crypto15MLConfig {
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
    horizonMinutes: parseNumber(process.env.CRYPTO15ML_HORIZON_MINUTES, 15),
    symbols: parseStringArray(process.env.CRYPTO15ML_SYMBOLS, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']),
    thresholdBps: {
      BTC: parseNumber(process.env.CRYPTO15ML_THRESHOLD_BTC, 0.0008),
      ETH: parseNumber(process.env.CRYPTO15ML_THRESHOLD_ETH, 0.0010),
      SOL: parseNumber(process.env.CRYPTO15ML_THRESHOLD_SOL, 0.0020),
      XRP: parseNumber(process.env.CRYPTO15ML_THRESHOLD_XRP, 0.0015),
    },
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Create logger using shared infrastructure
  const logger: IStrategyLogger = createCrypto15MLLogger({
    app: 'crypto15ml',
  });

  logger.info(LogEvents.STRATEGY_STARTED, { message: 'Crypto15ML Strategy starting...' });

  // Validate environment
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    logger.error(LogEvents.ERROR, { message: 'POLYMARKET_PRIVATE_KEY is required' });
    process.exit(1);
  }

  // Load configuration
  const config = loadConfig();
  logger.info(LogEvents.MODELS_LOADED, {
    message: 'Configuration loaded',
    dryRun: config.dryRun,
  });

  // Handle disabled state with proper signal handling
  if (!config.enabled) {
    logger.warn(LogEvents.STRATEGY_STOPPED, { message: 'Strategy is disabled via CRYPTO15ML_ENABLED=false' });
    // Wait for shutdown signal with proper cleanup
    await new Promise<void>((resolve) => {
      const handleSignal = () => {
        logger.info(LogEvents.STRATEGY_STOPPED, { message: 'Received shutdown signal while disabled' });
        resolve();
      };
      process.on('SIGINT', handleSignal);
      process.on('SIGTERM', handleSignal);
    });
    process.exit(0);
  }

  // Initialize SDK
  logger.info(LogEvents.STRATEGY_STARTED, { message: 'Initializing PolymarketSDK...' });
  const sdk = await PolymarketSDK.create({ privateKey });
  logger.info(LogEvents.STRATEGY_STARTED, { message: 'SDK initialized successfully' });

  // Create strategy service
  const strategy = new Crypto15MLStrategyService(
    sdk.markets,
    sdk.tradingService,
    sdk.realtime,
    config
  );

  // Attach event handlers
  strategy.on('signal', (signal) => {
    logger.info(LogEvents.SIGNAL_GENERATED, {
      marketId: signal.conditionId,
      slug: signal.slug,
      symbol: signal.asset,
      side: signal.side,
      confidence: signal.probability,
      entryPrice: signal.entryPrice,
      stateMinute: signal.stateMinute,
    });
  });

  strategy.on('execution', (result) => {
    const event = result.orderResult.success ? LogEvents.EXECUTION_SUCCESS : LogEvents.EXECUTION_FAILED;
    logger.info(event, {
      marketId: result.signal.conditionId,
      side: result.signal.side,
      symbol: result.signal.asset,
      success: result.orderResult.success,
      error: result.orderResult.errorMsg,
    });
  });

  strategy.on('paperPosition', (position) => {
    logger.info(LogEvents.PAPER_POSITION, {
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
    logger.info(LogEvents.PAPER_SETTLEMENT, {
      marketId: result.position.marketId,
      symbol: result.position.symbol,
      side: result.position.side,
      pnl: result.pnl,
    });
  });

  strategy.on('error', (error) => {
    logger.error(LogEvents.ERROR, {
      message: error.message,
      error: error.stack,
    });
  });

  // Start strategy
  logger.info(LogEvents.STRATEGY_STARTED, { message: 'Starting Crypto15ML strategy...' });
  await strategy.start();
  logger.info(LogEvents.STRATEGY_STARTED, {
    message: 'Strategy started successfully',
    dryRun: config.dryRun,
    trackerCount: strategy.getTrackerCount(),
  });

  // Handle shutdown signals with proper error handling
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(LogEvents.STRATEGY_STOPPED, { message: `Shutdown initiated (${signal})` });

    // Log final stats if in dry-run mode
    if (config.dryRun) {
      const stats = strategy.getPaperTradingStats();
      logger.info(LogEvents.STRATEGY_STOPPED, {
        message: 'Final paper trading stats',
        positionCount: stats.positionCount,
        pnl: stats.cumulativePnL,
      });
    }

    strategy.stop();
    sdk.stop();
    logger.info(LogEvents.STRATEGY_STOPPED, { message: 'Shutdown complete' });
    process.exit(0);
  };

  // Wrap signal handlers with error handling
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      logger.error(LogEvents.ERROR, { message: 'Shutdown error', error: String(err) });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      logger.error(LogEvents.ERROR, { message: 'Shutdown error', error: String(err) });
      process.exit(1);
    });
  });

  // Keep alive
  logger.info(LogEvents.STRATEGY_STARTED, { message: 'Strategy is running. Press Ctrl+C to stop.' });
}

main().catch((error) => {
  // Use console.error for fatal errors before logger might be available
  const errorEntry = {
    timestamp: new Date().toISOString(),
    level: 'ERROR',
    strategy: 'Crypto15ML',
    event: 'error',
    message: error.message,
    error: error.stack,
    _service: 'hermes',
    _app: 'crypto15ml',
    _env: process.env.NODE_ENV || 'development',
  };
  console.log(JSON.stringify(errorEntry));
  process.exit(1);
});
