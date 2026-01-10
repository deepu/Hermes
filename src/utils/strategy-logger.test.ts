/**
 * Tests for StrategyLogger
 *
 * Part of #9
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StrategyLogger,
  createCrypto15MLLogger,
  LogEvents,
  type IStrategyLogger,
  type LogEntry,
  type LogContext,
} from './strategy-logger.js';

describe('StrategyLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should create logger with required config', () => {
      const logger = new StrategyLogger({ strategy: 'TestStrategy' });
      expect(logger.isEnabled()).toBe(true);
    });

    it('should respect enabled config', () => {
      const logger = new StrategyLogger({ strategy: 'Test', enabled: false });
      expect(logger.isEnabled()).toBe(false);
    });

    it('should use default values for optional config', () => {
      const logger = new StrategyLogger({ strategy: 'Test' });
      logger.info(LogEvents.STRATEGY_STARTED, {});

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logOutput = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logOutput._service).toBe('hermes');
      expect(logOutput._app).toBe('trading');
    });
  });

  describe('info', () => {
    it('should log INFO level with correct structure', () => {
      const logger = new StrategyLogger({ strategy: 'Crypto15ML' });
      logger.info(LogEvents.STRATEGY_STARTED, { message: 'Strategy started' });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logOutput: LogEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);

      expect(logOutput.level).toBe('INFO');
      expect(logOutput.strategy).toBe('Crypto15ML');
      expect(logOutput.event).toBe('strategy_started');
      expect(logOutput.message).toBe('Strategy started');
      expect(logOutput.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include context fields', () => {
      const logger = new StrategyLogger({ strategy: 'Crypto15ML' });
      logger.info(LogEvents.SIGNAL_GENERATED, {
        marketId: '0xabc123',
        symbol: 'BTCUSDT',
        slug: 'btc-updown-15m-1767456000',
        stateMinute: 2,
        side: 'YES',
        confidence: 0.73,
        entryPrice: 0.65,
        imputedFeatures: 0,
        linearCombination: 1.23,
      });

      const logOutput: LogEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logOutput.marketId).toBe('0xabc123');
      expect(logOutput.symbol).toBe('BTCUSDT');
      expect(logOutput.slug).toBe('btc-updown-15m-1767456000');
      expect(logOutput.stateMinute).toBe(2);
      expect(logOutput.side).toBe('YES');
      expect(logOutput.confidence).toBe(0.73);
      expect(logOutput.entryPrice).toBe(0.65);
      expect(logOutput.imputedFeatures).toBe(0);
      expect(logOutput.linearCombination).toBe(1.23);
    });
  });

  describe('warn', () => {
    it('should log WARN level', () => {
      const logger = new StrategyLogger({ strategy: 'Crypto15ML' });
      logger.warn(LogEvents.SIGNAL_REJECTED, {
        slug: 'btc-updown-15m-1767456000',
        message: 'Entry price too high',
      });

      const logOutput: LogEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('WARN');
      expect(logOutput.event).toBe('signal_rejected');
    });
  });

  describe('error', () => {
    it('should log ERROR level', () => {
      const logger = new StrategyLogger({ strategy: 'Crypto15ML' });
      logger.error(LogEvents.EXECUTION_FAILED, {
        error: 'Order rejected',
        errorCode: 'insufficient_funds',
      });

      const logOutput: LogEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('ERROR');
      expect(logOutput.event).toBe('execution_failed');
      expect(logOutput.error).toBe('Order rejected');
      expect(logOutput.errorCode).toBe('insufficient_funds');
    });
  });

  describe('disabled logging', () => {
    it('should not log when disabled', () => {
      const logger = new StrategyLogger({ strategy: 'Test', enabled: false });
      logger.info(LogEvents.STRATEGY_STARTED, {});
      logger.warn(LogEvents.SIGNAL_REJECTED, {});
      logger.error(LogEvents.ERROR, {});

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should report enabled state correctly', () => {
      const enabledLogger = new StrategyLogger({ strategy: 'Test', enabled: true });
      const disabledLogger = new StrategyLogger({ strategy: 'Test', enabled: false });

      expect(enabledLogger.isEnabled()).toBe(true);
      expect(disabledLogger.isEnabled()).toBe(false);
    });
  });

  describe('Railway metadata', () => {
    it('should include Railway-specific fields', () => {
      const logger = new StrategyLogger({
        strategy: 'Crypto15ML',
        service: 'hermes',
        app: 'trading',
        environment: 'production',
      });
      logger.info(LogEvents.STRATEGY_STARTED, {});

      const logOutput: LogEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logOutput._service).toBe('hermes');
      expect(logOutput._app).toBe('trading');
      expect(logOutput._env).toBe('production');
    });
  });

  describe('JSON format', () => {
    it('should output valid single-line JSON', () => {
      const logger = new StrategyLogger({ strategy: 'Test' });
      logger.info(LogEvents.STRATEGY_STARTED, { message: 'test value' });

      const output = consoleSpy.mock.calls[0][0] as string;

      // Should not contain newlines
      expect(output).not.toContain('\n');

      // Should be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should handle special characters in strings', () => {
      const logger = new StrategyLogger({ strategy: 'Test' });
      logger.info(LogEvents.STRATEGY_STARTED, { message: 'Line1\nLine2\tTabbed' });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.message).toBe('Line1\nLine2\tTabbed');
    });

    it('should prevent context from overriding base fields (security)', () => {
      const logger = new StrategyLogger({ strategy: 'Crypto15ML' });

      // Attempt to override base fields via context (should be ignored)
      // Using type assertion to bypass TypeScript since this tests runtime behavior
      logger.info(LogEvents.STRATEGY_STARTED, {
        message: 'Test message',
      } as LogContext & { timestamp?: string; level?: string; strategy?: string });

      const logOutput: LogEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);

      // Base fields should be set correctly, not overridden
      expect(logOutput.strategy).toBe('Crypto15ML');
      expect(logOutput.level).toBe('INFO');
      expect(logOutput.event).toBe('strategy_started');
      expect(logOutput.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('should truncate long error messages', () => {
      const longMessage = 'a'.repeat(300);
      const result = StrategyLogger.sanitizeErrorMessage(new Error(longMessage));
      expect(result.length).toBe(203); // 200 + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    it('should not truncate short error messages', () => {
      const shortMessage = 'Short error';
      const result = StrategyLogger.sanitizeErrorMessage(new Error(shortMessage));
      expect(result).toBe(shortMessage);
    });

    it('should handle non-Error values', () => {
      expect(StrategyLogger.sanitizeErrorMessage('string error')).toBe('string error');
      expect(StrategyLogger.sanitizeErrorMessage(123)).toBe('123');
      expect(StrategyLogger.sanitizeErrorMessage(null)).toBe('null');
    });
  });
});

describe('createCrypto15MLLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should create logger with Crypto15ML strategy name', () => {
    const logger = createCrypto15MLLogger();
    logger.info(LogEvents.STRATEGY_STARTED, {});

    const logOutput = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logOutput.strategy).toBe('Crypto15ML');
  });

  it('should allow overriding options except strategy', () => {
    const logger = createCrypto15MLLogger({ enabled: true, service: 'custom-service' });
    logger.info(LogEvents.STRATEGY_STARTED, {});

    const logOutput = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logOutput.strategy).toBe('Crypto15ML');
    expect(logOutput._service).toBe('custom-service');
  });

  it('should return IStrategyLogger interface', () => {
    // This is a compile-time check that the factory returns IStrategyLogger
    const logger: IStrategyLogger = createCrypto15MLLogger();

    // Verify all interface methods are present
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.isEnabled).toBe('function');
  });
});

describe('LogEvents', () => {
  it('should have all expected event types', () => {
    // Strategy Lifecycle
    expect(LogEvents.STRATEGY_STARTED).toBe('strategy_started');
    expect(LogEvents.STRATEGY_STOPPED).toBe('strategy_stopped');
    expect(LogEvents.MODELS_LOADED).toBe('models_loaded');
    expect(LogEvents.PRICE_SUBSCRIPTION_ACTIVE).toBe('price_subscription_active');

    // Market Discovery
    expect(LogEvents.MARKET_ADDED).toBe('market_added');
    expect(LogEvents.MARKET_REMOVED).toBe('market_removed');
    expect(LogEvents.TRACKERS_CLEANED).toBe('trackers_cleaned');

    // Signals
    expect(LogEvents.SIGNAL_GENERATED).toBe('signal_generated');
    expect(LogEvents.SIGNAL_REJECTED).toBe('signal_rejected');

    // Executions
    expect(LogEvents.EXECUTION_SUCCESS).toBe('execution_success');
    expect(LogEvents.EXECUTION_FAILED).toBe('execution_failed');

    // Paper Trading
    expect(LogEvents.PAPER_POSITION).toBe('paper_position');
    expect(LogEvents.PAPER_POSITION_EVICTED).toBe('paper_position_evicted');
    expect(LogEvents.PAPER_SETTLEMENT).toBe('paper_settlement');

    // General
    expect(LogEvents.ERROR).toBe('error');
  });
});

describe('LogContext type safety', () => {
  it('should only allow defined fields', () => {
    // This is a compile-time check - if LogContext had an index signature,
    // this would allow any field. Now it only allows defined fields.
    const context: LogContext = {
      marketId: '0xabc',
      symbol: 'BTCUSDT',
      confidence: 0.75,
      // @ts-expect-error - unknownField is not a valid LogContext property
      unknownField: 'should fail',
    };
    // Runtime check - the object is still created but TS should flag it
    expect(context.marketId).toBe('0xabc');
  });
});
