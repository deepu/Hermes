/**
 * Binance WebSocket Client for Real-Time Price Data
 *
 * Provides real-time cryptocurrency price updates via Binance's WebSocket API.
 * Uses aggregate trade streams for accurate, high-frequency price data.
 *
 * Stream formats:
 * - Combined streams: wss://stream.binance.com:9443/stream?streams=<streamName>/<streamName>/...
 * - Aggregate trade: <symbol>@aggTrade (e.g., btcusdt@aggTrade)
 *
 * Features:
 * - Multi-symbol subscription
 * - Automatic reconnection
 * - Heartbeat/ping monitoring
 * - Type-safe event handling
 *
 * @see https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams
 * @see https://binance-docs.github.io/apidocs/spot/en/#aggregate-trade-streams
 */

import { EventEmitter } from 'events';
import WebSocket from 'isomorphic-ws';
import type { CryptoPrice } from '../types/price.types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Binance WebSocket client
 */
export interface BinanceWsConfig {
  /** Symbols to subscribe to (e.g., ['btcusdt', 'ethusdt']) */
  symbols: string[];
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 5000) */
  reconnectDelay?: number;
  /** Ping interval in ms for connection health check (default: 30000) */
  pingInterval?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /**
   * Maximum reconnection attempts (default: 100)
   * Set to Infinity for unlimited reconnection attempts (use with caution)
   */
  maxReconnectAttempts?: number;
  /** Maximum messages per second before dropping (default: 500, 0 = unlimited) */
  maxMessagesPerSecond?: number;
  /** Maximum burst messages (default: 1000) */
  maxBurstMessages?: number;
}

/**
 * Raw aggregate trade message from Binance WebSocket
 */
interface BinanceAggTrade {
  stream: string;
  data: {
    e: string;      // Event type: "aggTrade"
    E: number;      // Event time (ms)
    s: string;      // Symbol (BTCUSDT)
    p: string;      // Price (string)
    T: number;      // Trade time (ms)
  };
}

/**
 * Connection states
 */
export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
}

// ============================================================================
// BinanceWsClient Implementation
// ============================================================================

/**
 * Binance WebSocket client for real-time price data
 *
 * Events:
 * - 'price': Emitted for each price update (CryptoPrice)
 * - 'connected': Emitted when connection is established
 * - 'disconnected': Emitted when connection is lost
 * - 'error': Emitted on errors
 * - 'rateLimitExceeded': Emitted when message rate limit is exceeded
 */
export class BinanceWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<BinanceWsConfig>;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongTime: number = 0;
  private reconnectAttempts: number = 0;

  // Rate limiting state (token bucket algorithm)
  private rateLimit = {
    tokens: 0,
    lastRefill: 0,
  };

  // Pre-computed values for performance
  private readonly wsUrl: string;
  private readonly symbolMap: Map<string, string>; // BTCUSDT -> btcusdt

  // Bound event handlers (reused to prevent memory leaks)
  private readonly boundHandleOpen: () => void;
  private readonly boundHandleMessage: (data: WebSocket.Data) => void;
  private readonly boundHandleError: (error: Error) => void;
  private readonly boundHandleClose: (code: number, reason: string) => void;
  private readonly boundHandlePong: () => void;

  constructor(config: BinanceWsConfig) {
    super();
    this.config = {
      symbols: config.symbols,
      autoReconnect: config.autoReconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? 5000,
      pingInterval: config.pingInterval ?? 30000,
      debug: config.debug ?? false,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 100,
      maxMessagesPerSecond: config.maxMessagesPerSecond ?? 500,
      maxBurstMessages: config.maxBurstMessages ?? 1000,
    };

    // Initialize rate limit tokens
    this.rateLimit.tokens = this.config.maxBurstMessages;
    this.rateLimit.lastRefill = Date.now();

    // Pre-compute WebSocket URL with validation
    this.wsUrl = this.buildWebSocketUrl();

    // Pre-compute symbol mappings for O(1) lookup in hot path
    this.symbolMap = new Map();
    for (const symbol of this.config.symbols) {
      const upper = symbol.toUpperCase();
      const lower = symbol.toLowerCase();
      this.symbolMap.set(upper, lower);
    }

    // Bind event handlers once to prevent memory leaks during reconnection
    this.boundHandleOpen = this.handleOpen.bind(this);
    this.boundHandleMessage = this.handleMessage.bind(this);
    this.boundHandleError = this.handleError.bind(this);
    this.boundHandleClose = this.handleClose.bind(this);
    this.boundHandlePong = this.handlePong.bind(this);
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Connect to Binance WebSocket
   */
  connect(): this {
    // Guard against empty symbol array
    if (this.config.symbols.length === 0) {
      this.log('No symbols to subscribe to. Skipping connection.');
      return this;
    }

    if (this.state !== ConnectionState.DISCONNECTED) {
      this.log('Already connected or connecting');
      return this;
    }

    this.state = ConnectionState.CONNECTING;
    this.log('Connecting to Binance WebSocket...');

    try {
      this.ws = new WebSocket(this.wsUrl);

      // Use pre-bound handlers to prevent memory leaks
      this.ws.on('open', this.boundHandleOpen);
      this.ws.on('message', this.boundHandleMessage);
      this.ws.on('error', this.boundHandleError);
      this.ws.on('close', this.boundHandleClose);
      this.ws.on('pong', this.boundHandlePong);
    } catch (error) {
      this.log(`Connection error: ${error}`);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.handleConnectionError(errorObj);
    }

    return this;
  }

  /**
   * Disconnect from Binance WebSocket
   */
  disconnect(): void {
    this.log('Disconnecting...');
    const wasConnected = this.state !== ConnectionState.DISCONNECTED;
    this.state = ConnectionState.DISCONNECTED;
    this.reconnectAttempts = 0;
    this.clearTimers();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    // Only emit disconnected event if we were actually connected
    if (wasConnected) {
      this.emit('disconnected');
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get number of reconnection attempts
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  // ============================================================================
  // Private Methods - Connection Management
  // ============================================================================

  private buildWebSocketUrl(): string {
    // Validate and sanitize symbols to prevent URL injection
    const streams = this.config.symbols.map(symbol => {
      const sanitized = symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (sanitized !== symbol.toLowerCase()) {
        throw new Error(`Invalid symbol format: ${symbol}. Only alphanumeric characters allowed.`);
      }
      return `${sanitized}@aggTrade`;
    }).join('/');

    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    // Validate URL length
    if (url.length > 2048) {
      throw new Error('Too many symbols: URL length exceeds 2048 characters');
    }

    return url;
  }

  private handleOpen(): void {
    this.state = ConnectionState.CONNECTED;
    this.lastPongTime = Date.now();
    this.reconnectAttempts = 0;
    this.log('Connected to Binance WebSocket');

    // Start heartbeat monitoring
    this.startPingTimer();

    this.emit('connected');
  }

  private handleMessage(data: WebSocket.Data): void {
    // Rate limiting check (skip if disabled via maxMessagesPerSecond = 0)
    if (this.config.maxMessagesPerSecond > 0) {
      const now = Date.now();
      const elapsed = (now - this.rateLimit.lastRefill) / 1000;

      // Refill tokens based on elapsed time
      this.rateLimit.tokens = Math.min(
        this.config.maxBurstMessages,
        this.rateLimit.tokens + elapsed * this.config.maxMessagesPerSecond
      );
      this.rateLimit.lastRefill = now;

      // Check if we have tokens available
      if (this.rateLimit.tokens < 1) {
        this.log('Rate limit exceeded, dropping message');
        this.emit('rateLimitExceeded');
        return;
      }
      this.rateLimit.tokens -= 1;
    }

    // Cache toString() to prevent multiple calls in hot path
    const messageStr = data.toString();

    try {
      const message = JSON.parse(messageStr) as BinanceAggTrade;

      // Strict validation of message structure
      if (!message.stream || typeof message.stream !== 'string') {
        this.log(`Invalid message: missing or invalid stream field`);
        return;
      }

      if (!message.data || typeof message.data !== 'object') {
        this.log(`Invalid message: missing or invalid data field`);
        return;
      }

      const { data: trade } = message;

      // Validate event type
      if (trade.e !== 'aggTrade') {
        this.log(`Unknown event type: ${trade.e}`);
        return;
      }

      // Validate required fields
      if (typeof trade.s !== 'string' || typeof trade.p !== 'string' || typeof trade.T !== 'number') {
        this.log(`Invalid trade data: missing or invalid required fields`);
        return;
      }

      // Parse and validate price
      const price = parseFloat(trade.p);
      if (!Number.isFinite(price) || price <= 0) {
        this.log(`Invalid price value: ${trade.p}`);
        return;
      }

      // Validate timestamp is reasonable (within 1 minute of current time)
      // Reject messages with suspicious timestamps to prevent replay attacks
      const now = Date.now();
      const timeDiff = Math.abs(trade.T - now);
      if (timeDiff > 60000) {
        this.log(`Rejecting message with suspicious timestamp: ${trade.T} (diff: ${timeDiff}ms)`);
        this.emit('error', new Error('Timestamp validation failed - possible replay attack'));
        return;
      }

      // Use pre-computed symbol map for O(1) lookup instead of toLowerCase()
      const symbol = this.symbolMap.get(trade.s) || trade.s.toLowerCase();

      const priceUpdate: CryptoPrice = {
        symbol,
        price,
        timestamp: trade.T,
      };

      this.emit('price', priceUpdate);
    } catch (error) {
      this.log(`Failed to parse message: ${error}`);
      // Don't emit raw error to prevent information leakage
      this.emit('error', new Error('Message parsing error'));
    }
  }

  private handleError(error: Error): void {
    this.log(`WebSocket error: ${error.message}`);
    this.emit('error', error);
  }

  private handleClose(code: number, reason: string): void {
    this.log(`Connection closed: code=${code}, reason=${reason || 'none'}`);
    this.clearTimers();

    const wasConnected = this.state === ConnectionState.CONNECTED;
    this.state = ConnectionState.DISCONNECTED;

    if (wasConnected) {
      this.emit('disconnected');
    }

    // Auto-reconnect if enabled and under max attempts
    if (this.config.autoReconnect &&
        this.state === ConnectionState.DISCONNECTED &&
        this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.log(`Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`);
      this.emit('error', new Error('Max reconnection attempts reached'));
    }
  }

  private handleConnectionError(error: Error): void {
    this.log(`Connection error: ${error.message}`);
    this.state = ConnectionState.DISCONNECTED;
    this.emit('error', error);

    if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  private handlePong(): void {
    this.lastPongTime = Date.now();
    this.log('Received pong');
  }

  // ============================================================================
  // Private Methods - Heartbeat & Reconnection
  // ============================================================================

  private startPingTimer(): void {
    this.clearTimers();

    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.log('Sent ping');

        // Check if we haven't received a pong recently (allow 2x ping interval)
        const timeSinceLastPong = Date.now() - this.lastPongTime;
        if (timeSinceLastPong > this.config.pingInterval * 2) {
          this.log(`No pong received for ${timeSinceLastPong}ms, reconnecting...`);
          this.reconnect();
        }
      }
    }, this.config.pingInterval);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    this.reconnectAttempts++;
    this.state = ConnectionState.RECONNECTING;
    this.log(`Reconnecting in ${this.config.reconnectDelay}ms... (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, this.config.reconnectDelay);
  }

  private reconnect(): void {
    this.log('Attempting to reconnect...');
    this.clearTimers();

    // Close existing connection without emitting disconnected event
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    this.state = ConnectionState.DISCONNECTED;
    this.connect();
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[BinanceWsClient] ${message}`);
    }
  }
}
