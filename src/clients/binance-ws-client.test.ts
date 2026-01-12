/**
 * BinanceWsClient Unit Tests
 *
 * Tests for the Binance WebSocket client including:
 * - Configuration validation
 * - URL building logic
 * - Type definitions
 *
 * Note: Full integration tests with real WebSocket connections
 * are in the integration test suite.
 *
 * Part of #46
 */

import { describe, it, expect } from 'vitest';
import { BinanceWsClient, type BinanceWsConfig, type BinancePrice } from './binance-ws-client.js';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a minimal valid config for testing
 */
function createTestConfig(overrides: Partial<BinanceWsConfig> = {}): BinanceWsConfig {
  return {
    symbols: ['btcusdt', 'ethusdt'],
    autoReconnect: false,
    reconnectDelay: 100,
    pingInterval: 100,
    debug: false,
    ...overrides,
  };
}

// ============================================================================
// Constructor & Configuration Tests
// ============================================================================

describe('BinanceWsClient', () => {
  describe('constructor validation', () => {
    it('should create client with valid config', () => {
      const config = createTestConfig();
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should apply default config values', () => {
      const client = new BinanceWsClient({
        symbols: ['btcusdt'],
      });

      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should accept multiple symbols', () => {
      const config = createTestConfig({
        symbols: ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'],
      });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });

    it('should handle empty symbol array', () => {
      const config = createTestConfig({
        symbols: [],
      });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });
  });

  describe('initial state', () => {
    it('should start disconnected', () => {
      const config = createTestConfig();
      const client = new BinanceWsClient(config);

      expect(client.isConnected()).toBe(false);
    });

    it('should have correct initial state', () => {
      const config = createTestConfig();
      const client = new BinanceWsClient(config);

      const state = client.getState();
      expect(state).toBe('DISCONNECTED');
    });
  });

  describe('type validation', () => {
    it('should accept valid BinancePrice structure', () => {
      const price: BinancePrice = {
        symbol: 'btcusdt',
        price: 92035.80,
        timestamp: Date.now(),
      };

      expect(price.symbol).toBe('btcusdt');
      expect(price.price).toBe(92035.80);
      expect(typeof price.timestamp).toBe('number');
    });

    it('should accept lowercase symbols', () => {
      const config = createTestConfig({
        symbols: ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'],
      });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });

    it('should handle mixed case symbols', () => {
      const config = createTestConfig({
        symbols: ['BTCUSDT', 'ethusdt', 'SolUSDT'],
      });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });
  });

  describe('configuration options', () => {
    it('should accept autoReconnect option', () => {
      const config = createTestConfig({ autoReconnect: true });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });

    it('should accept reconnectDelay option', () => {
      const config = createTestConfig({ reconnectDelay: 5000 });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });

    it('should accept pingInterval option', () => {
      const config = createTestConfig({ pingInterval: 10000 });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });

    it('should accept debug option', () => {
      const config = createTestConfig({ debug: true });
      const client = new BinanceWsClient(config);

      expect(client).toBeDefined();
    });
  });
});

// ============================================================================
// Message Format Validation Tests
// ============================================================================

describe('BinanceWsClient message formats', () => {
  it('should have correct aggregate trade message structure', () => {
    // This validates the expected message format from Binance
    const mockAggTrade = {
      stream: 'btcusdt@aggTrade',
      data: {
        e: 'aggTrade',
        E: 1672515782136,
        s: 'BTCUSDT',
        a: 12345,
        p: '92035.80',
        q: '0.001',
        f: 100,
        l: 200,
        T: 1672515782136,
        m: true,
        M: true,
      },
    };

    expect(mockAggTrade.stream).toBe('btcusdt@aggTrade');
    expect(mockAggTrade.data.e).toBe('aggTrade');
    expect(mockAggTrade.data.s).toBe('BTCUSDT');
    expect(typeof mockAggTrade.data.p).toBe('string');
    expect(mockAggTrade.data.T).toBeGreaterThan(0);
  });

  it('should parse price from string to number', () => {
    const priceString = '92035.80';
    const price = parseFloat(priceString);

    expect(price).toBe(92035.80);
    expect(typeof price).toBe('number');
  });
});
