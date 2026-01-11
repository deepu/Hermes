/**
 * Crypto15MLStrategyService Integration Tests
 *
 * End-to-end integration tests validating the complete Crypto15ML strategy flow
 * from market discovery to signal generation.
 *
 * Tests cover:
 * - Full strategy lifecycle (start, run, stop)
 * - Market discovery (predictive + reactive)
 * - Price ingestion -> feature computation -> signal generation
 * - Signal conditions (state minute, confidence, entry price)
 * - Order execution (mocked TradingService)
 * - Event emissions (signal, execution, error)
 * - Error handling (WebSocket disconnection, API failures)
 *
 * Part of #7
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  Crypto15MLStrategyService,
  type Crypto15MLConfig,
  type Signal,
  type ExecutionResult,
  type MarketAddedEvent,
  type MarketRemovedEvent,
  type PaperPosition,
  type PaperSettlement,
} from './crypto15-ml-strategy-service.js';
import type { MarketService } from './market-service.js';
import type { TradingService, OrderResult } from './trading-service.js';
import type { RealtimeServiceV2, CryptoPrice, Subscription, CryptoPriceHandlers, MarketEvent } from './realtime-service-v2.js';
import type { UnifiedMarket, MarketToken } from '../core/types.js';
import type { GammaMarket } from '../clients/gamma-api.js';
import { Crypto15LRModel, type ModelConfig } from '../strategies/crypto15-lr-model.js';
import type { ITradeRepository } from '../types/trade-record.types.js';

// ============================================================================
// Test Constants
// ============================================================================

const WINDOW_MS = 15 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ASYNC_SETTLE_MS = 100;

// Use a fixed timestamp for reproducible tests (2024-01-01 00:00:00 UTC)
const MOCK_TIME = 1704067200000;
const TEST_WINDOW_START = Math.floor(MOCK_TIME / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
const TEST_END_TIME = TEST_WINDOW_START + WINDOW_MS;

// Test price constant
const TEST_BTC_PRICE = 98500;

// ============================================================================
// Mock Helpers
// ============================================================================

/**
 * Model intercept override for per-test model behavior.
 * Set before test to control probability output:
 * - intercept = 3.0 -> probability ~0.95 (high YES signal)
 * - intercept = -3.0 -> probability ~0.05 (high NO signal)
 * - intercept = 0.0 -> probability ~0.50 (neutral)
 */
let testModelIntercept = 0.0;

/**
 * Create a minimal valid model config for testing
 */
function createTestModelConfig(asset: string): ModelConfig {
  return {
    version: '1.0.0',
    asset,
    featureColumns: [
      'stateMinute', 'minutesRemaining', 'returnSinceOpen', 'return1m', 'return3m',
      'return5m', 'highLowRange', 'volatility5m', 'momentum3m', 'trendStrength',
      'aboveOpen', 'dayOfWeek', 'hourOfDay',
    ],
    // Use small coefficients so intercept dominates the output
    coefficients: [0.01, -0.01, 0.01, 0.01, 0.01, 0.01, 0.01, -0.01, 0.01, 0.01, 0.01, 0.001, 0.001],
    intercept: testModelIntercept,
    featureMedians: {
      stateMinute: 7,
      minutesRemaining: 8,
      returnSinceOpen: 0.0,
      return1m: 0.0,
      return3m: 0.0,
      return5m: 0.0,
      highLowRange: 0.001,
      volatility5m: 0.0005,
      momentum3m: 0.0,
      trendStrength: 0.5,
      aboveOpen: 0.5,
      dayOfWeek: 3,
      hourOfDay: 12,
    },
  };
}

/**
 * Create a test unified market
 */
function createTestMarket(
  conditionId: string,
  slug: string,
  endTime: number,
  prices: { yes: number; no: number } = { yes: 0.5, no: 0.5 }
): UnifiedMarket {
  return {
    conditionId,
    slug,
    question: `Will ${slug.split('-')[0].toUpperCase()} go up?`,
    tokens: [
      { tokenId: `${conditionId}-yes`, outcome: 'Up', price: prices.yes },
      { tokenId: `${conditionId}-no`, outcome: 'Down', price: prices.no },
    ] as MarketToken[],
    volume: 100000,
    liquidity: 50000,
    active: true,
    closed: false,
    acceptingOrders: true,
    endDate: new Date(endTime),
    source: 'gamma' as const,
  };
}

/**
 * Create default test config
 */
function createTestConfig(overrides: Partial<Crypto15MLConfig> = {}): Crypto15MLConfig {
  return {
    enabled: true,
    modelPath: 'models/crypto15-model.json',
    imputationPath: 'models/crypto15-imputation.json',
    stateMinutes: [0, 1, 2],
    horizonMinutes: 15,
    yesThreshold: 0.70,
    noThreshold: 0.30,
    entryPriceCap: 0.70,
    positionSizeUsd: 100.0,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
    thresholdBps: {
      BTC: 8,
      ETH: 10,
      SOL: 20,
      XRP: 15,
    },
    debug: false,
    dryRun: true, // Default to dry run for tests
    ...overrides,
  };
}

/**
 * Create mock MarketService
 */
function createMockMarketService(): MarketService & { mockGetMarket: Mock; mockScanCryptoShortTermMarkets: Mock } {
  const mockGetMarket = vi.fn();
  const mockScanCryptoShortTermMarkets = vi.fn().mockResolvedValue([]);

  return {
    getMarket: mockGetMarket,
    scanCryptoShortTermMarkets: mockScanCryptoShortTermMarkets,
    mockGetMarket,
    mockScanCryptoShortTermMarkets,
  } as unknown as MarketService & { mockGetMarket: Mock; mockScanCryptoShortTermMarkets: Mock };
}

/**
 * Create mock TradingService
 */
function createMockTradingService(): TradingService & { mockCreateMarketOrder: Mock } {
  const mockCreateMarketOrder = vi.fn().mockResolvedValue({
    success: true,
    orderId: 'test-order-123',
  } as OrderResult);

  return {
    createMarketOrder: mockCreateMarketOrder,
    mockCreateMarketOrder,
  } as unknown as TradingService & { mockCreateMarketOrder: Mock };
}

/**
 * Create mock RealtimeServiceV2 with controllable price emission
 */
function createMockRealtimeService(): RealtimeServiceV2 & {
  mockIsConnected: Mock;
  mockConnect: Mock;
  mockSubscribeCryptoChainlinkPrices: Mock;
  mockSubscribeMarketEvents: Mock;
  emitPrice: (price: CryptoPrice) => void;
  emitMarketEvent: (event: MarketEvent) => void;
  priceHandler: CryptoPriceHandlers | null;
} {
  let priceHandler: CryptoPriceHandlers | null = null;
  let marketEventHandler: ((event: MarketEvent) => void) | null = null;
  let subscriptionCounter = 0;

  const mockIsConnected = vi.fn().mockReturnValue(true);
  const mockConnect = vi.fn();
  const mockSubscribeCryptoChainlinkPrices = vi.fn((symbols: string[], handlers: CryptoPriceHandlers): Subscription => {
    priceHandler = handlers;
    subscriptionCounter++;
    return {
      id: `crypto_chainlink_${subscriptionCounter}`,
      topic: 'crypto_prices_chainlink',
      type: 'update',
      unsubscribe: vi.fn(),
    };
  });
  const mockSubscribeMarketEvents = vi.fn((handlers: { onMarketEvent?: (event: MarketEvent) => void }): Subscription => {
    marketEventHandler = handlers.onMarketEvent || null;
    subscriptionCounter++;
    return {
      id: `market_event_${subscriptionCounter}`,
      topic: 'clob_market',
      type: 'market_resolved',
      unsubscribe: vi.fn(),
    };
  });

  const mockService = {
    isConnected: mockIsConnected,
    connect: mockConnect,
    subscribeCryptoChainlinkPrices: mockSubscribeCryptoChainlinkPrices,
    subscribeMarketEvents: mockSubscribeMarketEvents,
    mockIsConnected,
    mockConnect,
    mockSubscribeCryptoChainlinkPrices,
    mockSubscribeMarketEvents,
    get priceHandler() {
      return priceHandler;
    },
    emitPrice: (price: CryptoPrice) => {
      if (priceHandler?.onPrice) {
        priceHandler.onPrice(price);
      }
    },
    emitMarketEvent: (event: MarketEvent) => {
      if (marketEventHandler) {
        marketEventHandler(event);
      }
    },
  };

  return mockService as unknown as RealtimeServiceV2 & {
    mockIsConnected: Mock;
    mockConnect: Mock;
    mockSubscribeCryptoChainlinkPrices: Mock;
    mockSubscribeMarketEvents: Mock;
    emitPrice: (price: CryptoPrice) => void;
    emitMarketEvent: (event: MarketEvent) => void;
    priceHandler: CryptoPriceHandlers | null;
  };
}

/**
 * Mock trade repository type with accessible mock functions
 */
type MockTradeRepository = ITradeRepository & {
  initialize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  recordTrade: ReturnType<typeof vi.fn>;
  updateOutcome: ReturnType<typeof vi.fn>;
  recordMinutePrice: ReturnType<typeof vi.fn>;
  recordMinutePrices: ReturnType<typeof vi.fn>;
  recordEvaluation: ReturnType<typeof vi.fn>;
  recordEvaluations: ReturnType<typeof vi.fn>;
  getEvaluationById: ReturnType<typeof vi.fn>;
};

/**
 * Create a mock trade repository with all required ITradeRepository methods.
 * Returns a properly typed mock that can be passed directly to the service
 * without 'as any' type assertions.
 */
function createMockTradeRepository(): MockTradeRepository {
  return {
    // Lifecycle
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    // Write operations
    recordTrade: vi.fn().mockResolvedValue(1),
    updateOutcome: vi.fn().mockResolvedValue(undefined),
    recordMinutePrice: vi.fn().mockResolvedValue(undefined),
    recordMinutePrices: vi.fn().mockResolvedValue(undefined),
    // Evaluation operations
    recordEvaluation: vi.fn().mockResolvedValue(1),
    recordEvaluations: vi.fn().mockResolvedValue([1]),
    getEvaluationById: vi.fn().mockResolvedValue(null),
    // Read operations (not used in current tests, but required by interface)
    getTradeByConditionId: vi.fn().mockResolvedValue(null),
    getPendingTrades: vi.fn().mockResolvedValue([]),
    getTradeById: vi.fn().mockResolvedValue(null),
    // Analysis queries
    getTradesByDateRange: vi.fn().mockResolvedValue([]),
    getTradesBySymbol: vi.fn().mockResolvedValue([]),
    getSymbolStats: vi.fn().mockResolvedValue({ symbol: 'BTC', totalTrades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 }),
    getAllSymbolStats: vi.fn().mockResolvedValue([]),
    getPerformanceByRegime: vi.fn().mockResolvedValue({ regime: 'mid', totalTrades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 }),
    getAllRegimeStats: vi.fn().mockResolvedValue([]),
    getCalibrationData: vi.fn().mockResolvedValue([]),
    // Maintenance
    vacuum: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ totalTrades: 0, pendingTrades: 0, resolvedTrades: 0, dbSizeBytes: 0 }),
    // Transaction support
    transaction: vi.fn().mockImplementation(<T>(fn: () => T) => Promise.resolve(fn())),
  };
}

// ============================================================================
// Test Helpers
// ============================================================================

// These helpers are initialized in beforeEach and used by helper functions
let _mockMarketService: ReturnType<typeof createMockMarketService>;
let _mockTradingService: ReturnType<typeof createMockTradingService>;
let _mockRealtimeService: ReturnType<typeof createMockRealtimeService>;
let _service: Crypto15MLStrategyService;

/**
 * Setup a BTC market for testing with standard configuration.
 * Reduces boilerplate in individual tests.
 */
function setupBtcMarket(
  conditionId: string,
  prices: { yes: number; no: number } = { yes: 0.50, no: 0.50 },
  endTime: number = TEST_END_TIME
): { slug: string; market: UnifiedMarket } {
  const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
  const slug = `btc-updown-15m-${windowStartSec}`;
  const market = createTestMarket(conditionId, slug, endTime, prices);
  _mockMarketService.mockGetMarket.mockResolvedValue(market);
  return { slug, market };
}

/**
 * Create and start a service with the given config overrides.
 * Returns the started service.
 */
async function createAndStartService(
  configOverrides: Partial<Crypto15MLConfig> = {}
): Promise<Crypto15MLStrategyService> {
  const config = createTestConfig(configOverrides);
  _service = new Crypto15MLStrategyService(
    _mockMarketService,
    _mockTradingService,
    _mockRealtimeService,
    config
  );
  await _service.start();
  return _service;
}

/**
 * Collect signals emitted by the service.
 * Returns an array that will be populated as signals are emitted.
 */
function collectSignals(service: Crypto15MLStrategyService): Signal[] {
  const signals: Signal[] = [];
  service.on('signal', (signal: Signal) => signals.push(signal));
  return signals;
}

/**
 * Collect execution results emitted by the service.
 */
function collectExecutions(service: Crypto15MLStrategyService): ExecutionResult[] {
  const executions: ExecutionResult[] = [];
  service.on('execution', (exec: ExecutionResult) => executions.push(exec));
  return executions;
}

/**
 * Collect errors emitted by the service.
 */
function collectErrors(service: Crypto15MLStrategyService): Error[] {
  const errors: Error[] = [];
  service.on('error', (err: Error) => errors.push(err));
  return errors;
}

/**
 * Emit a price update and wait for async processing to settle.
 */
async function emitPriceAndSettle(
  symbol: string = 'BTC/USD',
  price: number = TEST_BTC_PRICE,
  timestamp: number = TEST_WINDOW_START
): Promise<void> {
  _mockRealtimeService.emitPrice({ symbol, price, timestamp });
  await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Crypto15MLStrategyService Integration', () => {
  let service: Crypto15MLStrategyService;
  let mockMarketService: ReturnType<typeof createMockMarketService>;
  let mockTradingService: ReturnType<typeof createMockTradingService>;
  let mockRealtimeService: ReturnType<typeof createMockRealtimeService>;

  // Mock model loading
  vi.mock('../strategies/model-loader.js', () => ({
    loadModelsWithImputations: vi.fn(async () => {
      const models = new Map<string, Crypto15LRModel>();
      models.set('BTCUSDT', new Crypto15LRModel(createTestModelConfig('BTC')));
      models.set('ETHUSDT', new Crypto15LRModel(createTestModelConfig('ETH')));
      models.set('SOLUSDT', new Crypto15LRModel(createTestModelConfig('SOL')));
      models.set('XRPUSDT', new Crypto15LRModel(createTestModelConfig('XRP')));
      return models;
    }),
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_WINDOW_START);

    // Reset model intercept to neutral for each test
    testModelIntercept = 0.0;

    mockMarketService = createMockMarketService();
    mockTradingService = createMockTradingService();
    mockRealtimeService = createMockRealtimeService();

    // Initialize helper variables for test helper functions
    _mockMarketService = mockMarketService;
    _mockTradingService = mockTradingService;
    _mockRealtimeService = mockRealtimeService;
  });

  afterEach(() => {
    if (service?.isRunning()) {
      service.stop();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ============================================================================
  // Lifecycle Tests
  // ============================================================================

  describe('Lifecycle: start and stop', () => {
    it('should start successfully when enabled and realtime service is connected', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      await service.start();

      expect(service.isRunning()).toBe(true);
      expect(mockRealtimeService.mockSubscribeCryptoChainlinkPrices).toHaveBeenCalled();
    });

    it('should not start when disabled', async () => {
      const config = createTestConfig({ enabled: false });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      await service.start();

      expect(service.isRunning()).toBe(false);
    });

    it('should throw when realtime service is not connected', async () => {
      mockRealtimeService.mockIsConnected.mockReturnValue(false);
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      await expect(service.start()).rejects.toThrow('RealtimeService must be connected');
    });

    it('should stop cleanly and clear all trackers', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Setup a market to track
      const testMarket = createTestMarket('cond-1', 'btc-updown-15m-123456', TEST_END_TIME);
      mockMarketService.mockGetMarket.mockResolvedValue(testMarket);

      await service.start();

      // Verify running
      expect(service.isRunning()).toBe(true);

      // Stop
      service.stop();

      expect(service.isRunning()).toBe(false);
      expect(service.getTrackerCount()).toBe(0);
    });

    it('should be idempotent for multiple start calls', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      await service.start();
      await service.start(); // Second call should be no-op

      expect(service.isRunning()).toBe(true);
      // Should only subscribe once
      expect(mockRealtimeService.mockSubscribeCryptoChainlinkPrices).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent for stop calls when not running', () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Should not throw
      service.stop();
      service.stop();

      expect(service.isRunning()).toBe(false);
    });
  });

  // ============================================================================
  // Market Discovery Tests
  // ============================================================================

  describe('Market Discovery: Predictive scanning', () => {
    it('should discover upcoming markets on start', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Setup market that matches predictive scan pattern
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const testSlug = `btc-updown-15m-${windowStartSec}`;
      const testMarket = createTestMarket('cond-predict-1', testSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockImplementation(async (id: string) => {
        if (id === testSlug) return testMarket;
        throw new Error('Not found');
      });

      await service.start();

      expect(service.getTrackerCount()).toBeGreaterThan(0);
      const trackers = service.getTrackers();
      expect(trackers.some(t => t.slug === testSlug)).toBe(true);
    });

    it('should emit marketAdded event when tracker is created', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const testSlug = `btc-updown-15m-${windowStartSec}`;
      const testMarket = createTestMarket('cond-event-1', testSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockImplementation(async (id: string) => {
        if (id === testSlug) return testMarket;
        throw new Error('Not found');
      });

      const marketAddedEvents: MarketAddedEvent[] = [];
      service.on('marketAdded', (event) => marketAddedEvents.push(event));

      await service.start();

      expect(marketAddedEvents.length).toBeGreaterThan(0);
      const addedEvent = marketAddedEvents.find(e => e.slug === testSlug);
      expect(addedEvent).toBeDefined();
      expect(addedEvent?.asset).toBe('BTC');
      expect(addedEvent?.conditionId).toBe('cond-event-1');
    });

    it('should not create duplicate trackers for same market', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const testSlug = `btc-updown-15m-${windowStartSec}`;
      const testMarket = createTestMarket('cond-dup-1', testSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockResolvedValue(testMarket);

      await service.start();

      const initialCount = service.getTrackerCount();

      // Simulate another scan attempt (advance time for interval)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 10 minutes

      // Count should remain the same for this market
      const trackers = service.getTrackers();
      const btcTrackers = trackers.filter(t => t.slug === testSlug);
      expect(btcTrackers.length).toBe(1);
    });
  });

  describe('Market Discovery: Reactive scanning', () => {
    it('should discover active markets via reactive scan', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Predictive scan returns nothing
      mockMarketService.mockGetMarket.mockRejectedValue(new Error('Not found'));

      // Reactive scan finds a market
      const testSlug = 'eth-updown-15m-123456';
      const testMarket = createTestMarket('cond-react-1', testSlug, TEST_END_TIME);
      const gammaMarket: GammaMarket = {
        conditionId: 'cond-react-1',
        slug: testSlug,
        question: 'Will ETH go up?',
      } as GammaMarket;

      mockMarketService.mockScanCryptoShortTermMarkets.mockResolvedValue([gammaMarket]);
      mockMarketService.mockGetMarket.mockImplementation(async (id: string) => {
        if (id === 'cond-react-1') return testMarket;
        throw new Error('Not found');
      });

      await service.start();

      const trackers = service.getTrackers();
      expect(trackers.some(t => t.conditionId === 'cond-react-1')).toBe(true);
    });
  });

  // ============================================================================
  // Price Feed Tests
  // ============================================================================

  describe('Price Feed: Subscription and routing', () => {
    it('should subscribe to configured crypto symbols', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      await service.start();

      expect(mockRealtimeService.mockSubscribeCryptoChainlinkPrices).toHaveBeenCalledWith(
        expect.arrayContaining(['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD']),
        expect.any(Object)
      );
    });

    it('should route price updates to correct tracker by symbol', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Setup market tracker
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-route-btc', btcSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockImplementation(async (id: string) => {
        if (id === btcSlug) return btcMarket;
        throw new Error('Not found');
      });

      await service.start();

      // Verify tracker was created
      const trackers = service.getTrackers();
      const btcTracker = trackers.find(t => t.asset === 'BTC');
      expect(btcTracker).toBeDefined();

      // Emit a price update for BTC
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: 98500,
        timestamp: TEST_WINDOW_START,
      });

      // No error should occur - price was routed successfully
      expect(service.isRunning()).toBe(true);
    });

    it('should validate prices and reject invalid values', async () => {
      const config = createTestConfig({ debug: true });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-validate', btcSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockImplementation(async (id: string) => {
        if (id === btcSlug) return btcMarket;
        throw new Error('Not found');
      });

      await service.start();

      // Should not throw for negative price (silently rejected)
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: -100,
        timestamp: TEST_WINDOW_START,
      });

      // Should not throw for extreme price (silently rejected)
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: 10_000_000, // $10M - above max reasonable
        timestamp: TEST_WINDOW_START,
      });

      expect(service.isRunning()).toBe(true);
    });
  });

  // ============================================================================
  // Signal Generation Tests
  // ============================================================================

  describe('Signal Generation: YES signal with p >= 0.70', () => {
    it('should generate YES signal when probability exceeds threshold', async () => {
      // Set high intercept to produce probability ~0.95 (well above 0.70 threshold)
      testModelIntercept = 3.0;

      const config = createTestConfig({
        symbols: ['BTCUSDT'],
        thresholdBps: { BTC: 8 },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Setup market with low YES price (below entry cap of 0.70)
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-yes-sig', btcSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const signals: Signal[] = [];
      service.on('signal', (signal) => signals.push(signal));

      await service.start();

      // Ensure we have a tracker
      expect(service.getTrackerCount()).toBeGreaterThan(0);

      // Emit price at minute boundary (state minute 0)
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });

      // Wait for async processing
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Verify YES signal was generated
      expect(signals).toHaveLength(1);
      expect(signals[0].side).toBe('YES');
      expect(signals[0].probability).toBeGreaterThanOrEqual(0.70);
    });

    it('should include correct signal metadata', async () => {
      // Set high intercept to guarantee signal generation for metadata validation
      testModelIntercept = 3.0;

      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-meta', btcSlug, TEST_END_TIME, { yes: 0.40, no: 0.60 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const signals: Signal[] = [];
      service.on('signal', (signal) => signals.push(signal));

      await service.start();

      // Emit price at minute boundary to trigger signal
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Verify signal was generated and has correct structure
      expect(signals).toHaveLength(1);
      const signal = signals[0];
      expect(signal.conditionId).toBeDefined();
      expect(signal.slug).toBeDefined();
      expect(signal.asset).toBe('BTC');
      expect(['YES', 'NO']).toContain(signal.side);
      expect(signal.probability).toBeGreaterThanOrEqual(0);
      expect(signal.probability).toBeLessThanOrEqual(1);
      expect(signal.stateMinute).toBeGreaterThanOrEqual(0);
      expect(signal.stateMinute).toBeLessThanOrEqual(14);
      expect(signal.features).toBeDefined();
    });
  });

  describe('Signal Generation: NO signal with p <= 0.30', () => {
    it('should generate NO signal when probability is below threshold', async () => {
      // Set low intercept to produce probability ~0.05 (well below 0.30 threshold)
      testModelIntercept = -3.0;

      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      // NO price below entry cap to allow signal
      const btcMarket = createTestMarket('cond-no-sig', btcSlug, TEST_END_TIME, { yes: 0.60, no: 0.40 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const signals: Signal[] = [];
      service.on('signal', (signal) => signals.push(signal));

      await service.start();

      // Emit price at minute boundary to trigger signal
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Verify NO signal was generated
      expect(signals).toHaveLength(1);
      expect(signals[0].side).toBe('NO');
      expect(signals[0].probability).toBeLessThanOrEqual(0.30);
    });
  });

  describe('Signal Generation: Entry price cap enforcement', () => {
    it('should skip signal when entry price exceeds cap', async () => {
      // Set high intercept to produce signal-worthy probability
      testModelIntercept = 3.0;

      const config = createTestConfig({ entryPriceCap: 0.60 });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      // Both prices above entry cap of 0.60
      const btcMarket = createTestMarket('cond-price-cap', btcSlug, TEST_END_TIME, { yes: 0.75, no: 0.75 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const signals: Signal[] = [];
      service.on('signal', (signal) => signals.push(signal));

      await service.start();

      // Emit price
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Signal should not be generated due to price cap
      expect(signals).toHaveLength(0);
    });
  });

  describe('Signal Generation: State minute filtering', () => {
    it('should only generate signals in configured state minutes [0, 1, 2]', async () => {
      const config = createTestConfig({ stateMinutes: [0, 1, 2] });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-state-min', btcSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const signals: Signal[] = [];
      service.on('signal', (signal) => signals.push(signal));

      await service.start();

      // Emit prices at various state minutes
      for (let minute = 0; minute < 5; minute++) {
        mockRealtimeService.emitPrice({
          symbol: 'BTC/USD',
          price: 98500 + minute * 10,
          timestamp: TEST_WINDOW_START + minute * MINUTE_MS,
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
      }

      // All signals should be in state minutes 0, 1, or 2
      for (const signal of signals) {
        expect([0, 1, 2]).toContain(signal.stateMinute);
      }
    });

    it('should not generate signal at state minute 5', async () => {
      const config = createTestConfig({ stateMinutes: [0, 1, 2] });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-min-5', btcSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const signals: Signal[] = [];
      service.on('signal', (signal) => signals.push(signal));

      await service.start();

      // Skip to minute 5 and emit price
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: 98500,
        timestamp: TEST_WINDOW_START + 5 * MINUTE_MS,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // No signal should be generated at minute 5
      expect(signals.filter(s => s.stateMinute === 5).length).toBe(0);
    });
  });

  describe('Signal Generation: No duplicates for same market', () => {
    it('should mark market as traded after first signal', async () => {
      // Set high intercept to guarantee signal generation
      testModelIntercept = 3.0;

      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      // Use low entry price to pass price cap check
      const btcMarket = createTestMarket('cond-no-dup', btcSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      let signalCount = 0;
      service.on('signal', () => signalCount++);

      await service.start();

      // Emit multiple prices to attempt triggering multiple signals
      for (let i = 0; i < 3; i++) {
        mockRealtimeService.emitPrice({
          symbol: 'BTC/USD',
          price: TEST_BTC_PRICE,
          timestamp: TEST_WINDOW_START + i * MINUTE_MS,
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
      }

      // Exactly 1 signal per market (first one wins)
      expect(signalCount).toBe(1);

      // Verify tracker is marked as traded
      const trackers = service.getTrackers();
      const btcTracker = trackers.find(t => t.slug === btcSlug);
      expect(btcTracker).toBeDefined();
      expect(btcTracker!.traded).toBe(true);
    });
  });

  // ============================================================================
  // Order Execution Tests
  // ============================================================================

  describe('Order Execution: TradingService integration', () => {
    it('should execute order via TradingService after signal (non-dry-run)', async () => {
      // Set high intercept to guarantee signal generation
      testModelIntercept = 3.0;

      const config = createTestConfig({ dryRun: false });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-exec', btcSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);
      mockTradingService.mockCreateMarketOrder.mockResolvedValue({
        success: true,
        orderId: 'order-exec-123',
      });

      const executions: ExecutionResult[] = [];
      service.on('execution', (exec) => executions.push(exec));

      await service.start();

      // Emit price
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Verify execution occurred
      expect(executions).toHaveLength(1);
      expect(executions[0].orderResult.success).toBe(true);
      expect(mockTradingService.mockCreateMarketOrder).toHaveBeenCalled();
    });

    it('should emit execution event in dry-run mode without calling TradingService', async () => {
      // Set high intercept to guarantee signal generation
      testModelIntercept = 3.0;

      const config = createTestConfig({ dryRun: true });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-dry', btcSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const executions: ExecutionResult[] = [];
      service.on('execution', (exec) => executions.push(exec));

      await service.start();

      // Emit price
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // In dry run, TradingService should NOT be called
      expect(mockTradingService.mockCreateMarketOrder).not.toHaveBeenCalled();

      // Verify execution event was emitted with dry-run order ID
      expect(executions).toHaveLength(1);
      expect(executions[0].orderResult.orderId).toContain('dry-run');
    });
  });

  // ============================================================================
  // Event Emission Tests
  // ============================================================================

  describe('Event Emissions', () => {
    it('should emit error event on API failure', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Scan will fail
      mockMarketService.mockScanCryptoShortTermMarkets.mockRejectedValue(
        new Error('API connection failed')
      );

      const errors: Error[] = [];
      service.on('error', (err) => errors.push(err));

      await service.start();

      // Trigger reactive scan and wait for async processing
      await vi.advanceTimersByTimeAsync(60 * 1000 + ASYNC_SETTLE_MS);

      // Error should be emitted
      expect(errors.some(e => e.message.includes('API connection failed'))).toBe(true);
    });

    it('should emit marketRemoved event when tracker is cleaned up', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Create a market that will expire in 10 seconds (valid when added, expires during test)
      const shortEndTime = TEST_WINDOW_START + 10 * 1000;
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-expire', btcSlug, shortEndTime);

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      const removedEvents: MarketRemovedEvent[] = [];
      service.on('marketRemoved', (event) => removedEvents.push(event));

      await service.start();

      // Verify tracker was added
      expect(service.getTrackerCount()).toBe(1);

      // Advance time past market expiration (10s) and cleanup interval (30s)
      await vi.advanceTimersByTimeAsync(50 * 1000);

      // Verify tracker was removed and event emitted
      expect(service.getTrackerCount()).toBe(0);
      expect(removedEvents).toHaveLength(1);
      expect(removedEvents[0].slug).toBe(btcSlug);
    });
  });

  // ============================================================================
  // Tracker Cleanup Tests
  // ============================================================================

  describe('Tracker Cleanup', () => {
    it('should remove expired trackers every 30 seconds', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Create market that will expire in 10 seconds
      const shortEndTime = TEST_WINDOW_START + 10 * 1000;
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-cleanup', btcSlug, shortEndTime);

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      await service.start();

      // Verify tracker was created
      expect(service.getTrackerCount()).toBe(1);

      // Advance time past market end (10s) and cleanup interval (30s)
      await vi.advanceTimersByTimeAsync(50 * 1000);

      // Tracker count should be 0 after cleanup
      expect(service.getTrackerCount()).toBe(0);
    });
  });

  // ============================================================================
  // Configuration Validation Tests
  // ============================================================================

  describe('Configuration Validation', () => {
    it('should throw for invalid positionSizeUsd', () => {
      expect(() => {
        new Crypto15MLStrategyService(
          mockMarketService,
          mockTradingService,
          mockRealtimeService,
          createTestConfig({ positionSizeUsd: -100 })
        );
      }).toThrow('positionSizeUsd must be positive');
    });

    it('should throw for invalid yesThreshold', () => {
      expect(() => {
        new Crypto15MLStrategyService(
          mockMarketService,
          mockTradingService,
          mockRealtimeService,
          createTestConfig({ yesThreshold: 1.5 })
        );
      }).toThrow('yesThreshold must be between 0 and 1');
    });

    it('should throw for noThreshold >= yesThreshold', () => {
      expect(() => {
        new Crypto15MLStrategyService(
          mockMarketService,
          mockTradingService,
          mockRealtimeService,
          createTestConfig({ yesThreshold: 0.5, noThreshold: 0.6 })
        );
      }).toThrow('noThreshold must be less than yesThreshold');
    });

    it('should throw for empty symbols array', () => {
      expect(() => {
        new Crypto15MLStrategyService(
          mockMarketService,
          mockTradingService,
          mockRealtimeService,
          createTestConfig({ symbols: [] })
        );
      }).toThrow('symbols array cannot be empty');
    });

    it('should throw for unknown symbol', () => {
      expect(() => {
        new Crypto15MLStrategyService(
          mockMarketService,
          mockTradingService,
          mockRealtimeService,
          createTestConfig({ symbols: ['UNKNOWN'] })
        );
      }).toThrow('Unknown symbol');
    });

    it('should throw for missing thresholdBps', () => {
      expect(() => {
        new Crypto15MLStrategyService(
          mockMarketService,
          mockTradingService,
          mockRealtimeService,
          createTestConfig({
            symbols: ['BTCUSDT'],
            thresholdBps: {}, // Missing BTC threshold
          })
        );
      }).toThrow('Missing thresholdBps for asset BTC');
    });

    it('should throw for stateMinutes out of range', () => {
      expect(() => {
        new Crypto15MLStrategyService(
          mockMarketService,
          mockTradingService,
          mockRealtimeService,
          createTestConfig({ stateMinutes: [0, 1, 15] }) // 15 is out of range
        );
      }).toThrow('stateMinutes values must be between 0 and 14');
    });
  });

  // ============================================================================
  // Feature Computation Tests
  // ============================================================================

  describe('Feature Computation: Minute boundaries', () => {
    it('should compute features only at minute boundaries', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-boundary', btcSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      let signalCount = 0;
      service.on('signal', () => signalCount++);

      await service.start();

      // Emit multiple prices within same minute - should only trigger once
      const baseTime = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: 98500, timestamp: baseTime });
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: 98510, timestamp: baseTime + 10000 });
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: 98520, timestamp: baseTime + 30000 });

      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Only one signal opportunity (at minute boundary)
      expect(signalCount).toBeLessThanOrEqual(1);
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle trading service errors gracefully', async () => {
      // Set high intercept to guarantee signal generation
      testModelIntercept = 3.0;

      const config = createTestConfig({ dryRun: false });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-error', btcSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);
      mockTradingService.mockCreateMarketOrder.mockRejectedValue(new Error('Order rejected'));

      const errors: Error[] = [];
      service.on('error', (err) => errors.push(err));

      await service.start();

      // Emit price to trigger signal and order attempt
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });

      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Service should still be running despite trade error
      expect(service.isRunning()).toBe(true);
      // Verify error was captured
      expect(errors.some(e => e.message.includes('Order rejected'))).toBe(true);
    });

    it('should handle transient errors and allow retry', async () => {
      // Set high intercept to guarantee signal generation
      testModelIntercept = 3.0;

      const config = createTestConfig({ dryRun: false });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-transient', btcSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      // First call fails with transient error, subsequent calls succeed
      mockTradingService.mockCreateMarketOrder
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ success: true, orderId: 'retry-order-123' });

      const errors: Error[] = [];
      service.on('error', (err) => errors.push(err));

      await service.start();

      // Emit price to trigger signal
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });

      // Wait for async execution to complete
      await vi.advanceTimersByTimeAsync(500);

      // Service should still be running after transient error
      expect(service.isRunning()).toBe(true);
      // Verify the timeout error was captured
      expect(errors.some(e => e.message.includes('timeout'))).toBe(true);
    });

    it('should continue running after price handler errors', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // No markets - price updates will be ignored
      mockMarketService.mockGetMarket.mockRejectedValue(new Error('Not found'));

      await service.start();

      // Emit malformed price (unknown symbol)
      mockRealtimeService.emitPrice({
        symbol: 'UNKNOWN/USD',
        price: 100,
        timestamp: TEST_WINDOW_START,
      });

      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Service should continue running
      expect(service.isRunning()).toBe(true);
    });
  });

  // ============================================================================
  // Getter Tests
  // ============================================================================

  describe('Getters', () => {
    it('should return tracker count correctly', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      expect(service.getTrackerCount()).toBe(0);

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-count', btcSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      await service.start();

      // After starting with a valid market, tracker count should be exactly 1
      expect(service.getTrackerCount()).toBe(1);
    });

    it('should return tracker info correctly', async () => {
      const config = createTestConfig();
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const btcMarket = createTestMarket('cond-info', btcSlug, TEST_END_TIME);

      mockMarketService.mockGetMarket.mockResolvedValue(btcMarket);

      await service.start();

      const trackers = service.getTrackers();

      for (const tracker of trackers) {
        expect(tracker.conditionId).toBeDefined();
        expect(tracker.slug).toBeDefined();
        expect(['BTC', 'ETH', 'SOL', 'XRP']).toContain(tracker.asset);
        expect(typeof tracker.endTime).toBe('number');
        expect(typeof tracker.traded).toBe('boolean');
      }
    });
  });

  // ============================================================================
  // Paper Trading (Dry-Run Mode) Tests
  // ============================================================================

  describe('Paper Trading: Dry-Run Mode', () => {
    // Helper constants for paper trading tests
    const WINDOW_START_SEC = Math.floor(TEST_WINDOW_START / 1000);
    const MODEL_INTERCEPT_YES = 3.0;
    const MODEL_INTERCEPT_NO = -3.0;

    // Helper to create and start service with paper trading enabled
    async function setupPaperTradingService(
      conditionId: string,
      prices: { yes: number; no: number },
      configOverrides: Partial<Crypto15MLConfig> = {}
    ): Promise<{ slug: string; market: UnifiedMarket }> {
      const slug = `btc-updown-15m-${WINDOW_START_SEC}`;
      const market = createTestMarket(conditionId, slug, TEST_END_TIME, prices);

      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({ dryRun: true, ...configOverrides });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      await service.start();
      return { slug, market };
    }

    // Helper to trigger a signal by emitting a price
    async function triggerSignal(): Promise<void> {
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
    }

    it('should emit paperPosition event when signal is generated in dry-run mode', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      const { slug } = await setupPaperTradingService('cond-paper-1', { yes: 0.50, no: 0.50 });

      const paperPositions: PaperPosition[] = [];
      service.on('paperPosition', (pos) => paperPositions.push(pos));

      await triggerSignal();

      // Verify paperPosition event was emitted
      expect(paperPositions).toHaveLength(1);
      expect(paperPositions[0].marketId).toBe('cond-paper-1');
      expect(paperPositions[0].slug).toBe(slug);
      expect(paperPositions[0].symbol).toBe('BTC');
      expect(paperPositions[0].side).toBe('YES');
      expect(paperPositions[0].entryPrice).toBe(0.50);
      expect(paperPositions[0].size).toBe(100.0);
    });

    it('should track paper position correctly after signal', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      await setupPaperTradingService('cond-paper-track', { yes: 0.60, no: 0.40 }, { positionSizeUsd: 50 });

      await triggerSignal();

      // Verify paper trading stats
      const stats = service.getPaperTradingStats();
      expect(stats.positionCount).toBe(1);
      expect(stats.positions[0].size).toBe(50);
    });

    it('should emit paperSettlement event when market resolves UP with YES position', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      await setupPaperTradingService('cond-settle-up', { yes: 0.60, no: 0.40 });

      const settlements: PaperSettlement[] = [];
      service.on('paperSettlement', (s) => settlements.push(s));

      await triggerSignal();

      // Simulate market resolution (UP)
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-settle-up',
        type: 'resolved',
        data: { winner: 'Up', outcome: 'UP' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Verify settlement event
      expect(settlements).toHaveLength(1);
      expect(settlements[0].outcome).toBe('UP');
      expect(settlements[0].won).toBe(true);
      // P&L = (1.0 - 0.60) * 100 = 40
      expect(settlements[0].pnl).toBe(40);
    });

    it('should emit paperSettlement with loss when market resolves opposite to position', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES; // Will generate YES signal

      await setupPaperTradingService('cond-settle-loss', { yes: 0.65, no: 0.35 });

      const settlements: PaperSettlement[] = [];
      service.on('paperSettlement', (s) => settlements.push(s));

      await triggerSignal();

      // Simulate market resolution (DOWN - opposite to YES position)
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-settle-loss',
        type: 'resolved',
        data: { winner: 'Down' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Verify settlement event with loss
      expect(settlements).toHaveLength(1);
      expect(settlements[0].outcome).toBe('DOWN');
      expect(settlements[0].won).toBe(false);
      // P&L = -0.65 * 100 = -65
      expect(settlements[0].pnl).toBe(-65);
    });

    it('should calculate NO position P&L correctly on DOWN outcome (win)', async () => {
      testModelIntercept = MODEL_INTERCEPT_NO; // Will generate NO signal

      await setupPaperTradingService('cond-no-win', { yes: 0.60, no: 0.40 });

      const settlements: PaperSettlement[] = [];
      service.on('paperSettlement', (s) => settlements.push(s));

      await triggerSignal();

      // Simulate market resolution (DOWN - matches NO position)
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-no-win',
        type: 'resolved',
        data: { outcome: 'down' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Verify settlement event with win
      expect(settlements).toHaveLength(1);
      expect(settlements[0].position.side).toBe('NO');
      expect(settlements[0].won).toBe(true);
      // P&L = (1.0 - 0.40) * 100 = 60
      expect(settlements[0].pnl).toBe(60);
    });

    it('should track cumulative P&L across multiple settlements', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      const config = createTestConfig({ dryRun: true });
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
      );

      // Create two markets
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const btcSlug = `btc-updown-15m-${windowStartSec}`;
      const ethSlug = `eth-updown-15m-${windowStartSec}`;

      const btcMarket = createTestMarket('cond-cumul-1', btcSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      const ethMarket = createTestMarket('cond-cumul-2', ethSlug, TEST_END_TIME, { yes: 0.50, no: 0.50 });

      mockMarketService.mockGetMarket.mockImplementation(async (id: string) => {
        if (id === btcSlug) return btcMarket;
        if (id === ethSlug) return ethMarket;
        throw new Error('Not found');
      });

      await service.start();

      // Emit prices to trigger signals for both markets
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      mockRealtimeService.emitPrice({
        symbol: 'ETH/USD',
        price: 3500,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // First settlement (win): P&L = (1 - 0.5) * 100 = 50
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-cumul-1',
        type: 'resolved',
        data: { winner: 'Up' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Check intermediate stats
      let stats = service.getPaperTradingStats();
      expect(stats.cumulativePnL).toBe(50);

      // Second settlement (loss): P&L = -0.5 * 100 = -50
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-cumul-2',
        type: 'resolved',
        data: { winner: 'Down' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Check final cumulative P&L
      stats = service.getPaperTradingStats();
      expect(stats.cumulativePnL).toBe(0); // 50 - 50 = 0
    });

    it('should subscribe to market events only in dry-run mode', async () => {
      // Test with dryRun: true
      const config1 = createTestConfig({ dryRun: true });
      const service1 = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config1
      );

      await service1.start();
      expect(mockRealtimeService.mockSubscribeMarketEvents).toHaveBeenCalled();
      service1.stop();

      // Reset mock
      mockRealtimeService.mockSubscribeMarketEvents.mockClear();

      // Test with dryRun: false
      const config2 = createTestConfig({ dryRun: false });
      const service2 = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config2
      );

      await service2.start();
      expect(mockRealtimeService.mockSubscribeMarketEvents).not.toHaveBeenCalled();
      service2.stop();
    });

    it('should not call TradingService in dry-run mode', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      await setupPaperTradingService('cond-no-trade', { yes: 0.50, no: 0.50 });

      await triggerSignal();

      // TradingService should NOT be called
      expect(mockTradingService.mockCreateMarketOrder).not.toHaveBeenCalled();
    });

    it('should remove paper position after settlement', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      await setupPaperTradingService('cond-remove', { yes: 0.50, no: 0.50 });

      await triggerSignal();

      // Should have 1 position
      expect(service.getPaperTradingStats().positionCount).toBe(1);

      // Settle the position
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-remove',
        type: 'resolved',
        data: { winner: 'Up' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Position should be removed after settlement
      expect(service.getPaperTradingStats().positionCount).toBe(0);
    });

    it('should clear paper trading state on stop()', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      await setupPaperTradingService('cond-clear', { yes: 0.50, no: 0.50 });

      await triggerSignal();

      // Should have 1 position before stop
      expect(service.getPaperTradingStats().positionCount).toBe(1);

      // Stop the service
      service.stop();

      // Paper trading state should be cleared
      expect(service.getPaperTradingStats().positionCount).toBe(0);
      expect(service.getPaperTradingStats().cumulativePnL).toBe(0);
    });
  });

  // ============================================================================
  // Persistence Integration Tests
  // ============================================================================

  describe('Trade Persistence Integration', () => {
    const MODEL_INTERCEPT_YES = 3.0;

    it('should initialize repository on start when persistence is enabled', async () => {
      const mockRepo = createMockTradeRepository();

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      expect(mockRepo.initialize).toHaveBeenCalledTimes(1);
    });

    it('should not initialize repository when persistence is disabled', async () => {
      const mockRepo = createMockTradeRepository();

      const config = createTestConfig({
        persistence: {
          enabled: false,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      expect(mockRepo.initialize).not.toHaveBeenCalled();
    });

    it('should persist trade when paper position is recorded', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-persist-1', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Add the tracker by scanning
      await (service as any).scanUpcomingMarkets();

      // Feed prices to trigger a signal
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle (including setImmediate for persistence)
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100); // Extra time for setImmediate

      // Trade should have been persisted
      expect(mockRepo.recordTrade).toHaveBeenCalledTimes(1);
      expect(mockRepo.recordTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          conditionId: 'cond-persist-1',
          slug,
          symbol: 'BTC',
          side: 'YES',
        })
      );
    });

    it('should update outcome when market resolves', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-outcome-1', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Add the tracker by scanning
      await (service as any).scanUpcomingMarkets();

      // Feed prices to trigger a signal
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Verify trade was recorded
      expect(mockRepo.recordTrade).toHaveBeenCalledTimes(1);

      // Emit market resolution event (UP = YES wins)
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-outcome-1',
        type: 'resolved',
        data: { winner: 'Up' },
        timestamp: Date.now(),
      });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Outcome should have been updated
      expect(mockRepo.updateOutcome).toHaveBeenCalledTimes(1);
      expect(mockRepo.updateOutcome).toHaveBeenCalledWith(
        'cond-outcome-1',
        expect.objectContaining({
          outcome: 'UP',
          isWin: true, // YES position wins when market goes UP
        })
      );
    });

    it('should close repository on stop', async () => {
      const mockRepo = createMockTradeRepository();

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      service.stop();

      // Allow async close to complete
      await vi.advanceTimersByTimeAsync(100);

      expect(mockRepo.close).toHaveBeenCalledTimes(1);
    });

    it('should not persist trade when no repository is provided', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-no-repo', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig(); // No persistence config, no repository

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
        // No repository parameter
      );

      await service.start();

      // Add the tracker by scanning
      await (service as any).scanUpcomingMarkets();

      // Feed prices to trigger a signal
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Service should still work (paper trading) without crashing
      expect(service.getPaperTradingStats().positionCount).toBe(1);
    });

    it('should handle persistence errors gracefully', async () => {
      const mockRepo = createMockTradeRepository();
      mockRepo.recordTrade.mockRejectedValue(new Error('Database write failed'));

      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-error-1', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Add the tracker by scanning
      await (service as any).scanUpcomingMarkets();

      // Feed prices to trigger a signal
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Paper position should still be recorded even if persistence fails
      expect(service.getPaperTradingStats().positionCount).toBe(1);

      // Service should not crash
      expect(service.isRunning()).toBe(true);
    });
  });

  // ============================================================================
  // Evaluation Logging Tests (#37)
  // ============================================================================

  describe('Evaluation Logging', () => {
    const MODEL_INTERCEPT_YES = 3.0;   // High probability -> YES signal
    const MODEL_INTERCEPT_NO = -3.0;   // Low probability -> NO signal
    const MODEL_INTERCEPT_SKIP = 0.0;  // Mid probability -> SKIP (uncertain range)

    it('should record YES evaluation when probability >= yesThreshold', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-yes', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Trigger evaluation at minute 0
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Evaluation should have been recorded
      expect(mockRepo.recordEvaluation).toHaveBeenCalledTimes(1);
      expect(mockRepo.recordEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          conditionId: 'cond-eval-yes',
          slug,
          symbol: 'BTC',
          stateMinute: 0,
          decision: 'YES',
          reason: expect.stringContaining('>= YES threshold'),
          marketPriceYes: 0.50,
          marketPriceNo: 0.50,
        })
      );
    });

    it('should record NO evaluation when probability <= noThreshold', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_NO;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-no', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Trigger evaluation at minute 0
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Evaluation should have been recorded as NO
      expect(mockRepo.recordEvaluation).toHaveBeenCalledTimes(1);
      expect(mockRepo.recordEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          conditionId: 'cond-eval-no',
          decision: 'NO',
          reason: expect.stringContaining('<= NO threshold'),
        })
      );
    });

    it('should record SKIP evaluation when probability in uncertain range', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_SKIP;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-skip', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Trigger evaluation at minute 0
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Evaluation should have been recorded as SKIP
      expect(mockRepo.recordEvaluation).toHaveBeenCalledTimes(1);
      expect(mockRepo.recordEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          conditionId: 'cond-eval-skip',
          decision: 'SKIP',
          reason: expect.stringContaining('in uncertain range'),
        })
      );
    });

    it('should record SKIP evaluation when entry price cap rejects signal', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES; // Would be YES, but price is too high

      // Setup market with high price (above entry cap)
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-cap', slug, TEST_END_TIME, { yes: 0.80, no: 0.20 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        entryPriceCap: 0.70,
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Trigger evaluation at minute 0
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Evaluation should record SKIP with reason mentioning entry price cap
      expect(mockRepo.recordEvaluation).toHaveBeenCalledTimes(1);
      expect(mockRepo.recordEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          conditionId: 'cond-eval-cap',
          decision: 'SKIP',
          reason: expect.stringMatching(/entry price.*> cap/),
        })
      );
    });

    it('should include all required fields in evaluation record', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-fields', slug, TEST_END_TIME, { yes: 0.55, no: 0.45 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Trigger evaluation at minute 0
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Verify all required fields are present
      const evalRecord = mockRepo.recordEvaluation.mock.calls[0][0];
      expect(evalRecord).toMatchObject({
        conditionId: expect.any(String),
        slug: expect.any(String),
        symbol: expect.any(String),
        timestamp: expect.any(Number),
        stateMinute: expect.any(Number),
        modelProbability: expect.any(Number),
        linearCombination: expect.any(Number),
        imputedCount: expect.any(Number),
        marketPriceYes: expect.any(Number),
        marketPriceNo: expect.any(Number),
        decision: expect.any(String),
        reason: expect.any(String),
        featuresJson: expect.any(String),
      });

      // Verify featuresJson is valid JSON
      expect(() => JSON.parse(evalRecord.featuresJson)).not.toThrow();
    });

    it('should not record evaluation when repository is not configured', async () => {
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-norepo', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig(); // No persistence config

      // Create service without repository
      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config
        // No mockRepo passed
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Trigger evaluation
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Should not crash and signal should still be generated
      expect(service.isRunning()).toBe(true);
    });

    it('should handle evaluation persistence errors gracefully', async () => {
      const mockRepo = createMockTradeRepository();
      mockRepo.recordEvaluation.mockRejectedValue(new Error('Database error'));
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-error', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Trigger evaluation
      const timestamp = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: TEST_BTC_PRICE, timestamp });

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Service should not crash
      expect(service.isRunning()).toBe(true);
    });

    it('should record evaluation for each state minute', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_SKIP; // Use SKIP to allow multiple evaluations (no trade to block)

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-eval-multi', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        stateMinutes: [0, 1, 2],
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();
      await (service as any).scanUpcomingMarkets();

      // Feed prices at minute 0, 1, 2 (state minutes)
      const baseTime = TEST_WINDOW_START;
      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: 100000, timestamp: baseTime });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: 100100, timestamp: baseTime + 60_000 });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      mockRealtimeService.emitPrice({ symbol: 'BTC/USD', price: 100200, timestamp: baseTime + 120_000 });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(100);

      // Should have 3 evaluations (one for each state minute)
      expect(mockRepo.recordEvaluation).toHaveBeenCalledTimes(3);

      // Verify state minutes
      const calls = mockRepo.recordEvaluation.mock.calls;
      expect(calls[0][0].stateMinute).toBe(0);
      expect(calls[1][0].stateMinute).toBe(1);
      expect(calls[2][0].stateMinute).toBe(2);
    });
  });

  // ============================================================================
  // Minute Price Tracking Tests (#27)
  // ============================================================================

  describe('Minute Price Tracking', () => {
    const MODEL_INTERCEPT_YES = 3.0;

    it('should record minute prices at each minute boundary', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-minute-1', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Emit prices at multiple minute boundaries
      for (let minute = 0; minute < 5; minute++) {
        const timestamp = TEST_WINDOW_START + minute * MINUTE_MS;
        mockRealtimeService.emitPrice({
          symbol: 'BTC/USD',
          price: TEST_BTC_PRICE + minute * 10,
          timestamp,
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
      }

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(200);

      // With stateMinutes=[0,1,2] default, signal fires at minute 0, which triggers:
      // 1. Batch persist of minute 0 via recordMinutePrices (1 call with 1 price)
      // 2. Individual persists for minutes 1-4 via recordMinutePrice (4 calls)

      // Check batch call first (minute 0 collected before trade was persisted)
      expect(mockRepo.recordMinutePrices).toHaveBeenCalledTimes(1);
      const batchCall = mockRepo.recordMinutePrices.mock.calls[0] as [number, Array<{minuteOffset: number}>];
      expect(batchCall[0]).toBe(1); // tradeId
      expect(batchCall[1].length).toBe(1); // 1 price (minute 0)
      expect(batchCall[1][0].minuteOffset).toBe(0);

      // Check individual calls for minutes 1-4
      const individualCalls = mockRepo.recordMinutePrice.mock.calls;
      expect(individualCalls.length).toBe(4); // Minutes 1, 2, 3, 4

      // Verify call parameters are valid: [tradeId, minuteOffset, price, timestamp]
      for (const call of individualCalls) {
        expect(call).toHaveLength(4);
        expect(typeof call[0]).toBe('number'); // tradeId
        expect(call[1]).toBeGreaterThanOrEqual(1); // minuteOffset >= 1
        expect(call[1]).toBeLessThanOrEqual(14); // minuteOffset <= 14
        expect(typeof call[2]).toBe('number'); // price
        expect(typeof call[3]).toBe('number'); // timestamp
      }

      // Verify each minute offset 1-4 was called exactly once
      const minuteOffsets = individualCalls.map((call: unknown[]) => call[1] as number);
      expect(new Set(minuteOffsets).size).toBe(4); // All unique
      expect(minuteOffsets.sort()).toEqual([1, 2, 3, 4]);
    });

    it('should persist existing minute prices when trade is recorded', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-minute-2', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        stateMinutes: [2], // Only generate signal at minute 2
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Emit prices at minutes 0, 1, 2 (signal at 2, but prices 0, 1 already collected)
      for (let minute = 0; minute <= 2; minute++) {
        const timestamp = TEST_WINDOW_START + minute * MINUTE_MS;
        mockRealtimeService.emitPrice({
          symbol: 'BTC/USD',
          price: TEST_BTC_PRICE + minute * 10,
          timestamp,
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
      }

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(500);

      // Trade should have been recorded
      expect(mockRepo.recordTrade).toHaveBeenCalledTimes(1);

      // Existing minute prices (0, 1, 2) should have been batch persisted after trade
      // With stateMinutes=[2], signal fires at minute 2, which triggers batch persist
      // of all collected prices (minutes 0, 1, 2) via recordMinutePrices
      expect(mockRepo.recordMinutePrices).toHaveBeenCalledTimes(1);

      const batchCall = mockRepo.recordMinutePrices.mock.calls[0] as [number, Array<{minuteOffset: number}>];
      expect(batchCall[0]).toBe(1); // tradeId
      expect(batchCall[1].length).toBe(3); // 3 prices (minutes 0, 1, 2)

      // Verify each minute offset is unique and within 0-2 range
      const minuteOffsets = batchCall[1].map(mp => mp.minuteOffset);
      expect(new Set(minuteOffsets).size).toBe(3); // All unique
      expect(minuteOffsets.every(m => m >= 0 && m <= 2)).toBe(true);
    });

    it('should include timing metrics in outcome when market resolves', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-timing-1', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Emit initial price to trigger signal
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(ASYNC_SETTLE_MS);

      // Resolve the market
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-timing-1',
        type: 'resolved',
        data: { winner: 'Up' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(200);

      // Outcome should include excursion metrics
      expect(mockRepo.updateOutcome).toHaveBeenCalledWith(
        'cond-timing-1',
        expect.objectContaining({
          outcome: 'UP',
          isWin: true,
          maxFavorableExcursion: expect.any(Number),
          maxAdverseExcursion: expect.any(Number),
        })
      );
    });

    it('should not record duplicate minute prices for same minute offset', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-dup-minute', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Emit multiple prices at same minute (only first should be recorded as minute price)
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE + 10,
        timestamp: TEST_WINDOW_START + 10000, // Same minute
      });
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE + 20,
        timestamp: TEST_WINDOW_START + 30000, // Same minute
      });

      await vi.advanceTimersByTimeAsync(200);

      // Only one price at minute 0 should be recorded (in the batch)
      // The duplicate detection in Map prevents multiple entries for same minute
      // Since all prices are at minute 0 and the signal fires at minute 0,
      // the batch persist will have exactly 1 price for minute 0
      expect(mockRepo.recordMinutePrices).toHaveBeenCalledTimes(1);

      const batchCall = mockRepo.recordMinutePrices.mock.calls[0] as [number, Array<{minuteOffset: number}>];
      const prices = batchCall[1];

      // Should have exactly 1 price in the batch - duplicate detection prevents more
      expect(prices.length).toBe(1);
      expect(prices[0].minuteOffset).toBe(0);
    });

    it('should handle minute price persistence errors gracefully', async () => {
      const mockRepo = createMockTradeRepository();
      mockRepo.recordMinutePrice.mockRejectedValue(new Error('Minute price write failed'));
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-minute-error', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Emit price
      mockRealtimeService.emitPrice({
        symbol: 'BTC/USD',
        price: TEST_BTC_PRICE,
        timestamp: TEST_WINDOW_START,
      });
      await vi.advanceTimersByTimeAsync(200);

      // Service should continue running despite minute price persistence error
      expect(service.isRunning()).toBe(true);
      expect(service.getPaperTradingStats().positionCount).toBe(1);
    });

    it('should include window close price in outcome when available', async () => {
      const mockRepo = createMockTradeRepository();
      testModelIntercept = MODEL_INTERCEPT_YES;

      // Setup market
      const windowStartSec = Math.floor(TEST_WINDOW_START / 1000);
      const slug = `btc-updown-15m-${windowStartSec}`;
      const market = createTestMarket('cond-close-price', slug, TEST_END_TIME, { yes: 0.50, no: 0.50 });
      mockMarketService.mockGetMarket.mockResolvedValue(market);

      const config = createTestConfig({
        persistence: {
          enabled: true,
          dbPath: './test-data/trades.db',
          syncMode: 'async',
          vacuumIntervalHours: 24,
        },
      });

      service = new Crypto15MLStrategyService(
        mockMarketService,
        mockTradingService,
        mockRealtimeService,
        config,
        mockRepo
      );

      await service.start();

      // Emit prices through the entire window including minute 14 (close)
      for (let minute = 0; minute <= 14; minute++) {
        const timestamp = TEST_WINDOW_START + minute * MINUTE_MS;
        mockRealtimeService.emitPrice({
          symbol: 'BTC/USD',
          price: TEST_BTC_PRICE + minute * 10,
          timestamp,
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
      }

      await vi.advanceTimersByTimeAsync(200);

      // Resolve the market
      mockRealtimeService.emitMarketEvent({
        conditionId: 'cond-close-price',
        type: 'resolved',
        data: { winner: 'Up' },
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(200);

      // Outcome should include window close price (minute 14 price)
      expect(mockRepo.updateOutcome).toHaveBeenCalledWith(
        'cond-close-price',
        expect.objectContaining({
          windowClosePrice: TEST_BTC_PRICE + 14 * 10, // Price at minute 14
        })
      );
    });
  });
});
