/**
 * Shared price types used across services and clients
 */

/**
 * Cryptocurrency price update from any price source
 */
export interface CryptoPrice {
  /** Symbol in lowercase (e.g., 'btcusdt', 'btc/usd') */
  symbol: string;
  /** Current price */
  price: number;
  /** Timestamp in milliseconds */
  timestamp: number;
}
