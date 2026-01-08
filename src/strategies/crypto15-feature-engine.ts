/**
 * Crypto15FeatureEngine
 *
 * Feature computation engine for the 15-minute binary crypto market strategy.
 * Ingests real-time crypto prices and computes ML features at minute boundaries.
 *
 * Key responsibilities:
 * - Ingest second-level price updates
 * - Maintain 32-minute continuous price history buffer
 * - Compute features at minute boundaries only
 * - Handle window transitions (preserve price buffer, reset window state)
 * - Return NaN for insufficient data (model handles imputation)
 *
 * Threshold values per asset:
 * - BTC: 8 basis points (0.08%)
 * - ETH: 10 basis points (0.10%)
 * - SOL: 20 basis points (0.20%)
 * - XRP: 15 basis points (0.15%)
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Supported crypto assets for the 15-minute strategy
 */
export type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

/**
 * Threshold values in basis points (1 bps = 0.01%)
 */
export const ASSET_THRESHOLDS: Record<CryptoAsset, number> = {
  BTC: 0.0008,  // 8 bps
  ETH: 0.0010,  // 10 bps
  SOL: 0.0020,  // 20 bps
  XRP: 0.0015,  // 15 bps
};

/**
 * Feature vector computed at each minute boundary
 * All 17+ fields for ML model input
 */
export interface FeatureVector {
  // === Time features ===
  /** Current minute within the window (0-14) */
  stateMinute: number;
  /** Minutes remaining in window (15 - stateMinute) */
  minutesRemaining: number;
  /** Hour of day (0-23, UTC) */
  hourOfDay: number;
  /** Day of week (0=Sunday, 6=Saturday) */
  dayOfWeek: number;

  // === Return features ===
  /** Return since window open price */
  returnSinceOpen: number;
  /** Maximum run-up since open (highest return reached) */
  maxRunUp: number;
  /** Maximum run-down since open (lowest return reached) */
  maxRunDown: number;
  /** 1-minute lagged return */
  return1m: number;
  /** 3-minute lagged return */
  return3m: number;
  /** 5-minute lagged return */
  return5m: number;

  // === Volatility features ===
  /** 5-minute rolling volatility (standard deviation of returns) */
  volatility5m: number;

  // === Threshold hit features ===
  /** Whether up threshold has been hit this window */
  hasUpHit: boolean;
  /** Whether down threshold has been hit this window */
  hasDownHit: boolean;
  /** Minute when up threshold was first hit (NaN if not hit) */
  firstUpHitMinute: number;
  /** Minute when down threshold was first hit (NaN if not hit) */
  firstDownHitMinute: number;

  // === Meta ===
  /** Asset being tracked */
  asset: CryptoAsset;
  /** Unix timestamp (ms) of this feature computation */
  timestamp: number;
}

/**
 * Feature map format for model consumption
 */
export type FeatureMap = Record<string, number | boolean>;

/**
 * Internal price record with timestamp
 */
interface PriceRecord {
  price: number;
  timestamp: number;
}

/**
 * Window state (reset on window transitions)
 */
interface WindowState {
  /** Window open price */
  openPrice: number;
  /** Window start timestamp */
  windowStart: number;
  /** Maximum return reached this window */
  maxRunUp: number;
  /** Minimum return reached this window */
  maxRunDown: number;
  /** First minute up threshold was hit */
  firstUpHitMinute: number;
  /** First minute down threshold was hit */
  firstDownHitMinute: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Window duration in minutes, matching Crypto15 strategy interval */
const WINDOW_MINUTES = 15;

/** 15-minute window in milliseconds */
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;

/** Price history buffer size (32 minutes worth of closes) */
const BUFFER_SIZE = 32;

/** Milliseconds per minute */
const MINUTE_MS = 60 * 1000;

/** Milliseconds per hour */
const HOUR_MS = 60 * MINUTE_MS;

/** Milliseconds per day */
const DAY_MS = 24 * HOUR_MS;

/**
 * Unix epoch day-of-week offset.
 * Jan 1, 1970 was a Thursday (day 4 in 0=Sunday notation).
 * Used to calculate day-of-week from timestamp without Date object allocation.
 */
const EPOCH_DAY_OF_WEEK = 4;

/** 5-minute volatility requires 6 data points (5 returns between 6 prices) */
const VOLATILITY_MIN_POINTS = 6;

/** Asset to numeric encoding for ML model */
const ASSET_TO_NUMBER: Record<CryptoAsset, number> = {
  BTC: 0,
  ETH: 1,
  SOL: 2,
  XRP: 3,
};

// ============================================================================
// Crypto15FeatureEngine Implementation
// ============================================================================

export class Crypto15FeatureEngine {
  private asset: CryptoAsset;
  private threshold: number;

  /** Continuous buffer of minute closes (not cleared between windows) */
  private closeBuffer: PriceRecord[] = [];

  /** Current window state (reset on window transitions) */
  private windowState: WindowState | null = null;

  /** Last minute we computed features for (to detect minute boundaries) */
  private lastMinuteComputed: number = -1;

  constructor(asset: CryptoAsset) {
    if (!(asset in ASSET_THRESHOLDS)) {
      throw new Error(`Invalid asset: ${asset}`);
    }
    this.asset = asset;
    this.threshold = ASSET_THRESHOLDS[asset];
  }

  /**
   * Ingest a price update. Returns FeatureVector if at a minute boundary,
   * otherwise returns null.
   *
   * @param price - Current asset price (must be positive finite number)
   * @param timestamp - Unix timestamp in milliseconds (must be non-negative finite number)
   * @returns FeatureVector if at minute boundary, null otherwise
   * @throws Error if price or timestamp is invalid
   */
  ingestPrice(price: number, timestamp: number): FeatureVector | null {
    // Validate inputs
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('Invalid price: must be a positive finite number');
    }
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new Error('Invalid timestamp: must be a non-negative finite number');
    }

    // Calculate current minute within a 15-minute window
    const currentMinute = Math.floor(timestamp / MINUTE_MS);
    const windowIndex = currentMinute % WINDOW_MINUTES;

    // Check for window transition
    if (this.windowState === null || this.isNewWindow(timestamp)) {
      this.handleWindowTransition(price, timestamp);
    }

    // Update window state with current price (track max run-up/down)
    this.updateWindowState(price, windowIndex);

    // Only compute features at minute boundaries
    if (currentMinute === this.lastMinuteComputed) {
      return null;
    }

    // Add close to buffer at minute boundary
    this.addToBuffer(price, timestamp);

    this.lastMinuteComputed = currentMinute;

    // Compute and return features
    return this.computeFeatures(price, timestamp, windowIndex);
  }

  /**
   * Get current state for debugging/monitoring
   */
  getState(): {
    asset: CryptoAsset;
    threshold: number;
    bufferSize: number;
    windowState: WindowState | null;
    lastMinute: number;
  } {
    return {
      asset: this.asset,
      threshold: this.threshold,
      bufferSize: this.closeBuffer.length,
      windowState: this.windowState,
      lastMinute: this.lastMinuteComputed,
    };
  }

  /**
   * Convert feature vector to flat map for model input
   */
  static toFeatureMap(features: FeatureVector): FeatureMap {
    return {
      state_minute: features.stateMinute,
      minutes_remaining: features.minutesRemaining,
      hour_of_day: features.hourOfDay,
      day_of_week: features.dayOfWeek,
      return_since_open: features.returnSinceOpen,
      max_run_up: features.maxRunUp,
      max_run_down: features.maxRunDown,
      return_1m: features.return1m,
      return_3m: features.return3m,
      return_5m: features.return5m,
      volatility_5m: features.volatility5m,
      has_up_hit: features.hasUpHit,
      has_down_hit: features.hasDownHit,
      first_up_hit_minute: features.firstUpHitMinute,
      first_down_hit_minute: features.firstDownHitMinute,
      asset: this.assetToNumber(features.asset),
      timestamp: features.timestamp,
    };
  }

  /**
   * Reset the engine state (useful for testing or reinitializing)
   */
  reset(): void {
    this.closeBuffer = [];
    this.windowState = null;
    this.lastMinuteComputed = -1;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Check if we've entered a new 15-minute window
   */
  private isNewWindow(timestamp: number): boolean {
    if (!this.windowState) return true;

    const currentWindowStart = this.getWindowStart(timestamp);
    return currentWindowStart !== this.windowState.windowStart;
  }

  /**
   * Get the start timestamp of the 15-minute window containing this timestamp
   */
  private getWindowStart(timestamp: number): number {
    return Math.floor(timestamp / WINDOW_MS) * WINDOW_MS;
  }

  /**
   * Handle transition to a new window
   */
  private handleWindowTransition(price: number, timestamp: number): void {
    // Initialize new window state
    this.windowState = {
      openPrice: price,
      windowStart: this.getWindowStart(timestamp),
      maxRunUp: 0,
      maxRunDown: 0,
      firstUpHitMinute: NaN,
      firstDownHitMinute: NaN,
    };
  }

  /**
   * Update window state with current price (track run-up/down, threshold hits)
   */
  private updateWindowState(price: number, windowIndex: number): void {
    if (!this.windowState) return;

    const currentReturn = this.calculateReturn(
      price,
      this.windowState.openPrice
    );

    // Update max run-up/down
    if (currentReturn > this.windowState.maxRunUp) {
      this.windowState.maxRunUp = currentReturn;
    }
    if (currentReturn < this.windowState.maxRunDown) {
      this.windowState.maxRunDown = currentReturn;
    }

    // Check threshold hits
    if (
      Number.isNaN(this.windowState.firstUpHitMinute) &&
      currentReturn >= this.threshold
    ) {
      this.windowState.firstUpHitMinute = windowIndex;
    }
    if (
      Number.isNaN(this.windowState.firstDownHitMinute) &&
      currentReturn <= -this.threshold
    ) {
      this.windowState.firstDownHitMinute = windowIndex;
    }
  }

  /**
   * Add price to the continuous buffer
   */
  private addToBuffer(price: number, timestamp: number): void {
    this.closeBuffer.push({ price, timestamp });

    // Maintain buffer size - use slice for O(1) amortized instead of O(n) shift
    if (this.closeBuffer.length > BUFFER_SIZE) {
      this.closeBuffer = this.closeBuffer.slice(-BUFFER_SIZE);
    }
  }

  /**
   * Compute all features for the current state
   */
  private computeFeatures(
    price: number,
    timestamp: number,
    windowIndex: number
  ): FeatureVector {
    // Extract UTC time components directly from timestamp (avoid Date allocation)
    const hourOfDay = Math.floor((timestamp % DAY_MS) / HOUR_MS);
    const dayOfWeek = (Math.floor(timestamp / DAY_MS) + EPOCH_DAY_OF_WEEK) % 7;

    // Calculate lagged returns
    const return1m = this.getLaggedReturn(1);
    const return3m = this.getLaggedReturn(3);
    const return5m = this.getLaggedReturn(5);

    // Calculate volatility
    const volatility5m = this.calculateVolatility5m();

    // Calculate return since open
    const returnSinceOpen = this.windowState
      ? this.calculateReturn(price, this.windowState.openPrice)
      : NaN;

    return {
      // Time features
      stateMinute: windowIndex,
      minutesRemaining: WINDOW_MINUTES - windowIndex,
      hourOfDay,
      dayOfWeek,

      // Return features
      returnSinceOpen,
      maxRunUp: this.windowState?.maxRunUp ?? NaN,
      maxRunDown: this.windowState?.maxRunDown ?? NaN,
      return1m,
      return3m,
      return5m,

      // Volatility features
      volatility5m,

      // Threshold hit features
      hasUpHit: !Number.isNaN(this.windowState?.firstUpHitMinute),
      hasDownHit: !Number.isNaN(this.windowState?.firstDownHitMinute),
      firstUpHitMinute: this.windowState?.firstUpHitMinute ?? NaN,
      firstDownHitMinute: this.windowState?.firstDownHitMinute ?? NaN,

      // Meta
      asset: this.asset,
      timestamp,
    };
  }

  /**
   * Calculate return between two prices
   */
  private calculateReturn(currentPrice: number, basePrice: number): number {
    if (!basePrice || basePrice === 0) return NaN;
    return (currentPrice - basePrice) / basePrice;
  }

  /**
   * Get lagged return (N minutes ago vs now)
   */
  private getLaggedReturn(minutesAgo: number): number {
    const bufferLen = this.closeBuffer.length;

    // Need at least minutesAgo + 1 prices in buffer
    if (bufferLen < minutesAgo + 1) {
      return NaN;
    }

    const currentPrice = this.closeBuffer[bufferLen - 1].price;
    const pastPrice = this.closeBuffer[bufferLen - 1 - minutesAgo].price;

    return this.calculateReturn(currentPrice, pastPrice);
  }

  /**
   * Calculate 5-minute rolling volatility (standard deviation of returns)
   * Uses single-pass algorithm to avoid intermediate array allocations
   */
  private calculateVolatility5m(): number {
    const bufferLen = this.closeBuffer.length;

    // Need at least 6 prices for 5 returns
    if (bufferLen < VOLATILITY_MIN_POINTS) {
      return NaN;
    }

    // Single-pass variance calculation (avoids intermediate arrays)
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let i = bufferLen - 5; i < bufferLen; i++) {
      const ret = this.calculateReturn(
        this.closeBuffer[i].price,
        this.closeBuffer[i - 1].price
      );
      if (!Number.isNaN(ret)) {
        sum += ret;
        sumSq += ret * ret;
        count++;
      }
    }

    if (count < 2) {
      return NaN;
    }

    // Sample variance using computational formula: Var = (SumSq - Sum^2/n) / (n-1)
    // Guard against floating-point precision issues that could produce tiny negative values
    const variance = (sumSq - (sum * sum) / count) / (count - 1);

    return variance <= 0 ? 0 : Math.sqrt(variance);
  }

  /**
   * Convert asset to numeric encoding for model
   */
  private static assetToNumber(asset: CryptoAsset): number {
    return ASSET_TO_NUMBER[asset];
  }
}
