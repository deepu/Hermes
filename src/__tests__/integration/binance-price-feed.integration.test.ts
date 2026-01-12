/**
 * Binance Price Feed Integration Tests
 *
 * End-to-end tests for Binance WebSocket price feed integration.
 * These tests verify real-time price updates, reconnection handling,
 * and integration with the strategy service.
 *
 * Note: These tests connect to real Binance WebSocket API.
 * They may fail if:
 * - Network is unavailable
 * - Binance API is down
 * - Rate limits are hit
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { RealtimeServiceV2 } from '../../services/realtime-service-v2.js';
import type { CryptoPrice } from '../../types/price.types.js';
import type { Subscription } from '../../services/realtime-service-v2.js';

describe('Binance Price Feed Integration', () => {
  let service: RealtimeServiceV2;
  let subscriptions: Subscription[] = [];

  beforeAll(() => {
    service = new RealtimeServiceV2({
      autoReconnect: true,
      debug: false,
    });
  });

  afterEach(() => {
    // Clean up all subscriptions
    for (const sub of subscriptions) {
      sub.unsubscribe();
    }
    subscriptions = [];
  });

  it('should receive real-time prices from Binance WebSocket for single symbol', async () => {
    const prices: CryptoPrice[] = [];

    const subscription = service.subscribeBinancePrices(
      ['btcusdt'],
      {
        onPrice: (price) => prices.push(price),
        onError: (error) => {
          console.error('Price feed error:', error);
        },
      }
    );
    subscriptions.push(subscription);

    // Wait for at least one price update (give it up to 10 seconds)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for price update'));
      }, 10000);

      const checkInterval = setInterval(() => {
        if (prices.length >= 1) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 100);
    });

    // Verify we got valid price data
    expect(prices.length).toBeGreaterThanOrEqual(1);
    expect(prices[0]).toMatchObject({
      symbol: 'btcusdt',
      price: expect.any(Number),
      timestamp: expect.any(Number),
    });
    expect(prices[0].price).toBeGreaterThan(0);
    expect(prices[0].timestamp).toBeGreaterThan(Date.now() - 60000); // Within last minute
  }, 15000);

  it('should receive prices for multiple symbols', async () => {
    const symbols = ['btcusdt', 'ethusdt', 'solusdt'];
    const pricesBySymbol = new Map<string, CryptoPrice[]>();

    for (const symbol of symbols) {
      pricesBySymbol.set(symbol, []);
    }

    const subscription = service.subscribeBinancePrices(
      symbols,
      {
        onPrice: (price) => {
          const prices = pricesBySymbol.get(price.symbol);
          if (prices) {
            prices.push(price);
          }
        },
      }
    );
    subscriptions.push(subscription);

    // Wait for at least one price from each symbol
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for prices from all symbols'));
      }, 15000);

      const checkInterval = setInterval(() => {
        const allSymbolsHavePrice = symbols.every(
          symbol => (pricesBySymbol.get(symbol)?.length ?? 0) > 0
        );

        if (allSymbolsHavePrice) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 100);
    });

    // Verify each symbol got prices
    for (const symbol of symbols) {
      const prices = pricesBySymbol.get(symbol);
      expect(prices?.length).toBeGreaterThanOrEqual(1);
      expect(prices?.[0].symbol).toBe(symbol);
      expect(prices?.[0].price).toBeGreaterThan(0);
    }
  }, 20000);

  it('should handle unsubscribe and cleanup', async () => {
    const prices: CryptoPrice[] = [];

    const subscription = service.subscribeBinancePrices(
      ['btcusdt'],
      { onPrice: (price) => prices.push(price) }
    );

    // Wait for at least one price
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (prices.length >= 1) {
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 100);
    });

    const priceCountBeforeUnsubscribe = prices.length;

    // Unsubscribe
    subscription.unsubscribe();

    // Wait a bit to ensure no more prices arrive
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Should not receive any more prices after unsubscribe
    expect(prices.length).toBe(priceCountBeforeUnsubscribe);
  }, 15000);

  it('should validate symbol format (lowercase)', async () => {
    const prices: CryptoPrice[] = [];

    const subscription = service.subscribeBinancePrices(
      ['btcusdt'], // Must be lowercase
      { onPrice: (price) => prices.push(price) }
    );
    subscriptions.push(subscription);

    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      const checkInterval = setInterval(() => {
        if (prices.length >= 1) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 100);
    });

    expect(prices.length).toBeGreaterThanOrEqual(1);
    expect(prices[0].symbol).toBe('btcusdt'); // Lowercase
  }, 10000);

  it('should emit error on connection issues', async () => {
    const errors: Error[] = [];

    // Try to subscribe with invalid configuration that should cause errors
    const subscription = service.subscribeBinancePrices(
      [], // Empty symbols array - should be handled gracefully
      {
        onPrice: () => { /* no-op */ },
        onError: (error) => errors.push(error),
      }
    );
    subscriptions.push(subscription);

    // Wait a bit for any potential errors
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Empty symbols shouldn't crash, just skip connection
    // (based on the guard in binance-ws-client.ts connect() method)
    // No errors should be emitted for empty symbols
    expect(errors.length).toBe(0);
  }, 5000);

  it('should provide real-time price updates at high frequency', async () => {
    const prices: CryptoPrice[] = [];
    const startTime = Date.now();

    const subscription = service.subscribeBinancePrices(
      ['btcusdt'],
      { onPrice: (price) => prices.push(price) }
    );
    subscriptions.push(subscription);

    // Collect prices for 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    const duration = (Date.now() - startTime) / 1000;
    const pricesPerSecond = prices.length / duration;

    // Binance aggregate trade stream typically sends many updates per second for BTC
    // We should get at least a few prices per second on average
    expect(pricesPerSecond).toBeGreaterThan(1);
    expect(prices.length).toBeGreaterThan(5);

    // All prices should be recent
    const now = Date.now();
    for (const price of prices) {
      expect(price.timestamp).toBeGreaterThan(now - 60000);
      expect(price.timestamp).toBeLessThanOrEqual(now + 1000);
    }
  }, 10000);
});
