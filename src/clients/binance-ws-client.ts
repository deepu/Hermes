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
}

/**
 * Price update from Binance
 */
export interface BinancePrice {
  /** Symbol in lowercase (e.g., 'btcusdt') */
  symbol: string;
  /** Current price */
  price: number;
  /** Timestamp in milliseconds */
  timestamp: number;
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
    a: number;      // Aggregate trade ID
    p: string;      // Price (string)
    q: string;      // Quantity
    f: number;      // First trade ID
    l: number;      // Last trade ID
    T: number;      // Trade time (ms)
    m: boolean;     // Is buyer market maker
    M: boolean;     // Ignore
  };
}

/**
 * Connection states
 */
enum ConnectionState {
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
 * - 'price': Emitted for each price update (BinancePrice)
 * - 'connected': Emitted when connection is established
 * - 'disconnected': Emitted when connection is lost
 * - 'error': Emitted on errors
 */
export class BinanceWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<BinanceWsConfig>;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongTime: number = 0;

  constructor(config: BinanceWsConfig) {
    super();
    this.config = {
      symbols: config.symbols,
      autoReconnect: config.autoReconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? 5000,
      pingInterval: config.pingInterval ?? 30000,
      debug: config.debug ?? false,
    };
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Connect to Binance WebSocket
   */
  connect(): this {
    if (this.state !== ConnectionState.DISCONNECTED) {
      this.log('Already connected or connecting');
      return this;
    }

    this.state = ConnectionState.CONNECTING;
    this.log('Connecting to Binance WebSocket...');

    try {
      const url = this.buildWebSocketUrl();
      this.ws = new WebSocket(url);

      this.ws.on('open', this.handleOpen.bind(this));
      this.ws.on('message', this.handleMessage.bind(this));
      this.ws.on('error', this.handleError.bind(this));
      this.ws.on('close', this.handleClose.bind(this));
      this.ws.on('pong', this.handlePong.bind(this));
    } catch (error) {
      this.log(`Connection error: ${error}`);
      this.handleConnectionError(error as Error);
    }

    return this;
  }

  /**
   * Disconnect from Binance WebSocket
   */
  disconnect(): void {
    this.log('Disconnecting...');
    this.state = ConnectionState.DISCONNECTED;
    this.clearTimers();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    this.emit('disconnected');
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

  // ============================================================================
  // Private Methods - Connection Management
  // ============================================================================

  private buildWebSocketUrl(): string {
    // Build combined stream URL
    // Format: wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade/...
    const streams = this.config.symbols.map(symbol => `${symbol.toLowerCase()}@aggTrade`).join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
  }

  private handleOpen(): void {
    this.state = ConnectionState.CONNECTED;
    this.lastPongTime = Date.now();
    this.log('Connected to Binance WebSocket');

    // Start heartbeat monitoring
    this.startPingTimer();

    this.emit('connected');
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as BinanceAggTrade;

      // Validate message structure
      if (!message.stream || !message.data) {
        this.log(`Invalid message structure: ${data.toString()}`);
        return;
      }

      // Parse aggregate trade data
      const { data: trade } = message;
      if (trade.e !== 'aggTrade') {
        this.log(`Unknown event type: ${trade.e}`);
        return;
      }

      // Convert to BinancePrice and emit
      const price: BinancePrice = {
        symbol: trade.s.toLowerCase(),
        price: parseFloat(trade.p),
        timestamp: trade.T,
      };

      this.emit('price', price);
    } catch (error) {
      this.log(`Failed to parse message: ${error}`);
      this.emit('error', error);
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

    // Auto-reconnect if enabled
    if (this.config.autoReconnect && this.state === ConnectionState.DISCONNECTED) {
      this.scheduleReconnect();
    }
  }

  private handleConnectionError(error: Error): void {
    this.log(`Connection error: ${error.message}`);
    this.state = ConnectionState.DISCONNECTED;
    this.emit('error', error);

    if (this.config.autoReconnect) {
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

    this.state = ConnectionState.RECONNECTING;
    this.log(`Reconnecting in ${this.config.reconnectDelay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, this.config.reconnectDelay);
  }

  private reconnect(): void {
    this.log('Attempting to reconnect...');
    this.disconnect();
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
