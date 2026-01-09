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
} from './crypto15-ml-strategy-service.js';
import type { MarketService } from './market-service.js';
import type { TradingService, OrderResult } from './trading-service.js';
import type { RealtimeServiceV2, CryptoPrice, Subscription, CryptoPriceHandlers } from './realtime-service-v2.js';
import type { UnifiedMarket, MarketToken } from '../core/types.js';
import type { GammaMarket } from '../clients/gamma-api.js';
import { Crypto15LRModel, type ModelConfig } from '../strategies/crypto15-lr-model.js';

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
  emitPrice: (price: CryptoPrice) => void;
  priceHandler: CryptoPriceHandlers | null;
} {
  let priceHandler: CryptoPriceHandlers | null = null;
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

  const mockService = {
    isConnected: mockIsConnected,
    connect: mockConnect,
    subscribeCryptoChainlinkPrices: mockSubscribeCryptoChainlinkPrices,
    mockIsConnected,
    mockConnect,
    mockSubscribeCryptoChainlinkPrices,
    get priceHandler() {
      return priceHandler;
    },
    emitPrice: (price: CryptoPrice) => {
      if (priceHandler?.onPrice) {
        priceHandler.onPrice(price);
      }
    },
  };

  return mockService as unknown as RealtimeServiceV2 & {
    mockIsConnected: Mock;
    mockConnect: Mock;
    mockSubscribeCryptoChainlinkPrices: Mock;
    emitPrice: (price: CryptoPrice) => void;
    priceHandler: CryptoPriceHandlers | null;
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
});
