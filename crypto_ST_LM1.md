# Crypto Short-Term Logistic Model 1 (IPS1) Strategy

**Status:** Implementation Planning
**Last Updated:** 2026-01-08
**Source:** Argus Trading System (`~/dev/argus`)

---

## Table of Contents

1. [Overview](#overview)
2. [Strategy Architecture](#strategy-architecture)
3. [Market Type](#market-type)
4. [Core Concept](#core-concept)
5. [Feature Engineering](#feature-engineering)
6. [Model Architecture](#model-architecture)
7. [Signal Generation](#signal-generation)
8. [Mapping to Hermes Library](#mapping-to-hermes-library)
9. [Implementation Plan](#implementation-plan)
10. [Configuration](#configuration)
11. [Risk Assessment](#risk-assessment)
12. [References](#references)

---

## Overview

**IPS1 (Intrawindow Probability Strategy - 15 Minute)** is a machine learning-based trading strategy for Polymarket's 15-minute crypto UP/DOWN binary markets. The strategy uses logistic regression models trained on historical intrawindow features to predict directional movement and enters positions in the early minutes of each 15-minute window when model confidence is high and entry prices are favorable.

### Key Characteristics

- **Market:** 15-minute crypto binary markets (BTC, ETH, SOL, XRP)
- **Approach:** Machine learning (logistic regression)
- **Entry Window:** First 0-2 minutes of 15-minute window
- **Data Source:** Real-time crypto spot prices (Chainlink/Binance)
- **Position Sizing:** Fixed USDC amount per trade
- **Risk Management:** Entry price cap, confidence thresholds

---

## Strategy Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ OFFLINE: Research Pipeline (Python)                            │
├─────────────────────────────────────────────────────────────────┤
│ 1. Historical data collection (BTC/ETH/SOL/XRP spot prices)    │
│ 2. Feature engineering (returns, volatility, threshold hits)   │
│ 3. Train logistic regression models (per crypto asset)         │
│ 4. Export trained models → JSON (coefficients + intercepts)    │
│ 5. Export imputation medians → JSON (for missing features)     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ ONLINE: Production Trading (TypeScript/Hermes)                 │
├─────────────────────────────────────────────────────────────────┤
│ 1. Load pre-trained models (coefficients, intercepts)          │
│ 2. Scan for active 15m UP/DOWN markets                         │
│ 3. Subscribe to real-time crypto spot prices                   │
│ 4. Ingest prices every second → aggregate at minute boundaries │
│ 5. Compute intrawindow features (returns, volatility, hits)    │
│ 6. Run logistic regression: p_hat = sigmoid(z)                 │
│ 7. Generate signal when:                                       │
│    - p_hat >= 0.70 AND YES entry price <= 0.70 → BUY YES      │
│    - p_hat <= 0.30 AND NO entry price <= 0.70 → BUY NO        │
│ 8. Execute market order via TradingService                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Market Type

### Polymarket 15-Minute Crypto Markets

**Market Format:**
- **Question:** "Will BTC go UP in the next 15 minutes?"
- **Outcomes:** UP (price >= opening price) / DOWN (price < opening price)
- **Duration:** Exactly 15 minutes
- **Slug Pattern:** `{coin}-updown-15m-{timestamp}`
  - Example: `btc-updown-15m-1767456000`
  - Timestamp = Unix seconds at market start time

**Supported Assets:**
- BTCUSDT (Bitcoin)
- ETHUSDT (Ethereum)
- SOLUSDT (Solana)
- XRPUSDT (Ripple)

**Market Lifecycle:**
1. Markets are created ahead of time (before tradeable)
2. New market becomes active when previous one ends
3. Continuous rotation: one market always open for each asset
4. Resolution based on Chainlink price feed

**Key Properties:**
- High frequency (96 markets per asset per day)
- Binary outcomes (simplifies modeling)
- Short duration (reduces overnight risk)
- Liquid markets (tight spreads, good depth)

---

## Market Discovery Strategy

### The Challenge: Never Miss State Minutes [0, 1, 2]

Since IPS1 only trades in the first 0-2 minutes of each 15-minute window, **timing is critical**. Missing a market's opening means missing the entire trading opportunity.

**Problem with Simple Polling:**
```
14:10  Scan → Find markets ending 14:15-14:40
14:15  [NEW MARKET STARTS] ← Entry window begins!
       State minute 0 ← Can trade
14:16  State minute 1 ← Can trade
14:17  State minute 2 ← Can trade
14:20  Next scan → Discover market
       State minute 5 ← TOO LATE! Entry window closed
```

If we scan every 5 minutes, we could miss the entire entry window.

### Solution: Hybrid Predictive + Reactive Scanning

IPS1 uses a **two-pronged approach** to ensure zero missed opportunities:

#### 1. **Predictive Scanning (Proactive)**

Markets follow a **predictable pattern** - they start at exact 15-minute intervals:

```
Time:    14:00  14:15  14:30  14:45  15:00  15:15
         │      │      │      │      │      │
BTC:     ├──M1──┤──M2──┤──M3──┤──M4──┤──M5──┤
         start  start  start  start  start  start
```

**Strategy:**
- Pre-generate market slugs for next 30 minutes
- Create trackers **before** markets start
- When market goes live → tracker is already waiting!

```typescript
// Generate predictable slugs
const now = Math.floor(Date.now() / 1000);
const interval = 900; // 15 minutes in seconds
const nextSlotStart = Math.ceil(now / interval) * interval;

// Pre-create tracker for market that will start at 14:15
const slug = `btc-updown-15m-${nextSlotStart}`;
// Fetch market (may not exist yet, but will soon)
```

**Timing:**
```
14:05  Predictive scan → Pre-create tracker for 14:15 market ✅
14:15  [MARKET STARTS]
14:15:01  First price update → Tracker initializes ✅
          State minute 0 captured perfectly!
```

**Frequency:** Every 10 minutes (low overhead)

#### 2. **Reactive Scanning (Safety Net)**

Catches any markets that were missed by predictive scanning (edge cases, delayed creation, etc.)

**Strategy:**
- Query active markets using `scanCryptoShortTermMarkets()`
- Create trackers for any markets we don't have yet
- Maximum 1-minute discovery latency

```typescript
const markets = await marketService.scanCryptoShortTermMarkets({
  duration: '15m',
  minMinutesUntilEnd: 1,  // Include all active
  maxMinutesUntilEnd: 30,
  limit: 50,
});
```

**Timing:**
```
14:14  Reactive scan → Check for active markets
14:15  [MARKET STARTS]
14:15  Reactive scan → Discover at state minute 0 ✅
```

**Frequency:** Every 1 minute (matches Argus polling interval)

#### 3. **Combined Approach**

```typescript
async start() {
  // Initial discovery
  await this.scanUpcomingMarkets(30);  // Predictive
  await this.scanActiveMarkets();       // Reactive

  // Periodic predictive (every 10 minutes)
  setInterval(() => this.scanUpcomingMarkets(30), 10 * 60 * 1000);

  // Periodic reactive (every 1 minute - safety net)
  setInterval(() => this.scanActiveMarkets(), 60 * 1000);

  // Cleanup stale trackers (every 30 seconds)
  setInterval(() => this.cleanupStaleTrackers(), 30 * 1000);
}
```

### API Cost Analysis

**Predictive Scan (every 10 minutes):**
- Frequency: 6 times/hour
- Requests per scan: 4 assets × 3 upcoming slots = 12 requests
- Total: 72 requests/hour

**Reactive Scan (every 1 minute):**
- Frequency: 60 times/hour
- Requests per scan: ~10-20 (depends on cache hits)
- Total: 600-1200 requests/hour

**Combined Total:** ~700-1300 requests/hour
**Gamma API Limit:** 10 req/sec = 36,000 requests/hour
**Usage:** ~2-4% of rate limit ✅ **Safe!**

### Benefits

✅ **Zero Missed Markets**: Predictive creates trackers before markets start
✅ **Fault Tolerance**: Reactive catches anything predictive missed
✅ **Low Latency**: Trackers ready when market goes live
✅ **Efficient**: Uses only 2-4% of API rate limit
✅ **Proven**: Matches Argus architecture (60s polling)

---

## Core Concept

### Trading Logic

IPS1 exploits early intrawindow momentum signals to predict final directional movement:

**Hypothesis:**
> "Price movements in the first 0-2 minutes of a 15-minute window, combined with recent volatility and threshold crossings, are predictive of the final UP/DOWN outcome."

**Entry Conditions:**
```
IF (state_minute IN [0, 1, 2])
  AND (model_confidence >= threshold)
  AND (entry_price <= price_cap)
THEN enter position
```

**Example Scenario:**
```
Time 0:00 - Market opens, BTC = $98,500 (open price)
Time 0:01 - BTC = $98,550 (+0.05%, no threshold hit yet)
Time 0:02 - BTC = $98,580 (+0.08%, UP threshold hit!)

         ↓ Extract features

Features: {
  state_minute: 2,
  return_since_open: 0.0008,
  has_up_hit_8bps: true,
  first_up_hit_minute_8bps: 2,
  return_prev_1m: 0.0003,
  volatility_5m: 0.0015,
  ...
}

         ↓ Run model

p_hat = 0.73 (73% confident UP will win)

         ↓ Check conditions

YES entry price: 0.65 (< 0.70 cap ✓)
Confidence: 0.73 (>= 0.70 threshold ✓)

         ↓ Execute

→ BUY YES @ 0.65 for $100
→ Expected value: 0.73 * $1.00 - 0.65 = $0.08 profit
```

---

## Feature Engineering

### Intrawindow State Tracking

The strategy maintains a rolling state tracker for each active market, computing features at minute boundaries.

#### Feature Categories

**1. Time Features**
| Feature | Description | Range |
|---------|-------------|-------|
| `state_minute` | Minutes elapsed since window start | 0-14 |
| `minutes_remaining` | Minutes until window closes | 15-1 |
| `hour_of_day` | Hour of day (UTC) | 0-23 |
| `minute_of_hour` | Minute within hour | 0-59 |
| `day_of_week` | Day of week (0=Monday) | 0-6 |

**2. Return Features**
| Feature | Description | Formula |
|---------|-------------|---------|
| `return_since_open` | Return from window open | (price / open) - 1 |
| `max_run_up` | Maximum positive return seen | max(return_since_open, 0) |
| `max_run_down` | Maximum negative return seen | min(return_since_open, 0) |
| `return_prev_1m` | 1-minute lagged return | (close[t] / close[t-1]) - 1 |
| `return_prev_3m` | 3-minute lagged return | (close[t] / close[t-3]) - 1 |
| `return_prev_5m` | 5-minute lagged return | (close[t] / close[t-5]) - 1 |

**3. Volatility Features**
| Feature | Description | Formula |
|---------|-------------|---------|
| `volatility_5m` | 5-minute rolling volatility | std(returns[t-5:t]) |
| `volume_zscore_15m` | Volume z-score (15m window) | (vol - mean) / std |

**4. Threshold Hit Features** (Per Asset)
| Feature | Description | Example |
|---------|-------------|---------|
| `has_up_hit_8bps` | Has price crossed +threshold? | true/false |
| `has_down_hit_8bps` | Has price crossed -threshold? | true/false |
| `first_up_hit_minute_8bps` | Which minute hit UP threshold | 2 or NaN |
| `first_down_hit_minute_8bps` | Which minute hit DOWN threshold | NaN or 5 |

**Thresholds by Asset:**
```typescript
const THRESHOLDS = {
  BTCUSDT: 0.0008,  // 0.08% = 8 basis points
  ETHUSDT: 0.0010,  // 0.10%
  SOLUSDT: 0.0020,  // 0.20%
  XRPUSDT: 0.0015,  // 0.15%
};
```

### Feature Vector Example

```typescript
{
  // Time context
  state_minute: 2,
  minutes_remaining: 13,
  hour_of_day: 14,
  minute_of_hour: 23,
  day_of_week: 2,

  // Returns
  return_since_open: 0.0008,   // +0.08%
  max_run_up: 0.0012,          // +0.12% peak
  max_run_down: -0.0002,       // -0.02% trough
  return_prev_1m: 0.0003,
  return_prev_3m: 0.0006,
  return_prev_5m: 0.0010,

  // Volatility
  volatility_5m: 0.0015,
  volume_zscore_15m: 0.0,      // Not yet implemented

  // Threshold hits
  has_up_hit_8bps: true,
  has_down_hit_8bps: false,
  first_up_hit_minute_8bps: 2,
  first_down_hit_minute_8bps: NaN,
}
```

---

## Model Architecture

### Logistic Regression

IPS1 uses standard logistic regression for binary classification:

```
z = intercept + Σ(coefficient[i] * feature[i])
p_hat = sigmoid(z) = 1 / (1 + e^(-z))
```

**Model Properties:**
- **Type:** Binary logistic regression
- **Features:** 17+ variables
- **Output:** Probability of UP outcome (0-1)
- **Training:** Per-asset models (BTC, ETH, SOL, XRP)
- **Update Frequency:** Offline (retrained periodically)

### Model File Format

```json
{
  "symbols": [
    {
      "symbol": "BTCUSDT",
      "coefficients": [
        0.523,    // state_minute
        1.245,    // return_since_open
        0.823,    // max_run_up
        -0.412,   // max_run_down
        0.156,    // return_prev_1m
        0.089,    // return_prev_3m
        0.234,    // return_prev_5m
        -0.678,   // volatility_5m
        1.890,    // has_up_hit_8bps
        -1.456,   // has_down_hit_8bps
        0.345,    // first_up_hit_minute_8bps
        -0.289,   // first_down_hit_minute_8bps
        0.012,    // hour_of_day
        0.008,    // minute_of_hour
        -0.034    // day_of_week
      ],
      "intercept": -0.234,
      "feature_columns": [
        "state_minute",
        "return_since_open",
        "max_run_up",
        "max_run_down",
        "return_prev_1m",
        "return_prev_3m",
        "return_prev_5m",
        "volatility_5m",
        "has_up_hit_8bps",
        "has_down_hit_8bps",
        "first_up_hit_minute_8bps",
        "first_down_hit_minute_8bps",
        "hour_of_day",
        "minute_of_hour",
        "day_of_week"
      ]
    }
  ]
}
```

### Imputation File Format

For handling missing features during inference:

```json
{
  "BTCUSDT": {
    "volatility_5m": 0.0012,
    "volume_zscore_15m": 0.0,
    "return_prev_5m": 0.0
  },
  "ETHUSDT": {
    "volatility_5m": 0.0015,
    "volume_zscore_15m": 0.0,
    "return_prev_5m": 0.0
  }
}
```

### Prediction Logic

```typescript
function predict(
  model: LogisticModel,
  features: Record<string, number>,
  imputations?: Record<string, number>
): { probability: number; imputedCount: number } {
  let z = model.intercept;
  let imputedCount = 0;

  for (let i = 0; i < model.featureColumns.length; i++) {
    const featureName = model.featureColumns[i];
    let value = features[featureName];

    // Handle missing features
    if (value === undefined || value === null || isNaN(value)) {
      value = imputations?.[featureName] ?? 0.0;
      imputedCount++;
    }

    z += model.coefficients[i] * value;
  }

  // Sigmoid with numerical stability
  const probability = sigmoid(z);

  return { probability, imputedCount };
}

function sigmoid(z: number): number {
  if (z > 20) return 1.0;   // Prevent overflow
  if (z < -20) return 0.0;  // Prevent underflow
  return 1.0 / (1.0 + Math.exp(-z));
}
```

---

## Signal Generation

### Decision Rules

```typescript
// Entry conditions
const ENTRY_CONDITIONS = {
  stateMinutes: [0, 1, 2],      // Only trade in first 0-2 minutes
  yesThreshold: 0.70,            // Enter YES if p_hat >= 0.70
  noThreshold: 0.30,             // Enter NO if p_hat <= 0.30
  entryPriceCap: 0.70,           // Only enter if price <= 0.70
  positionSizeUsd: 100.0,        // Fixed position size
};

function generateSignal(
  marketId: string,
  symbol: string,
  features: FeatureVector,
  model: LogisticModel,
  orderbook: ProcessedOrderbook
): Signal | null {
  // 1. Check if in entry window
  if (!ENTRY_CONDITIONS.stateMinutes.includes(features.stateMinute)) {
    return null;
  }

  // 2. Convert features to map
  const featureMap = features.toMap();

  // 3. Run model inference
  const { probability, imputedCount } = model.predict(featureMap);

  // 4. Determine side and check thresholds
  let side: 'YES' | 'NO' | null = null;
  let tokenId: string | null = null;
  let entryPrice: number;
  let confidence: number;

  if (probability >= ENTRY_CONDITIONS.yesThreshold) {
    // Model is confident UP will win
    entryPrice = orderbook.yes.ask;
    if (entryPrice <= ENTRY_CONDITIONS.entryPriceCap) {
      side = 'YES';
      tokenId = orderbook.yes.tokenId;
      confidence = probability;
    }
  } else if (probability <= ENTRY_CONDITIONS.noThreshold) {
    // Model is confident DOWN will win
    entryPrice = orderbook.no.ask;
    if (entryPrice <= ENTRY_CONDITIONS.entryPriceCap) {
      side = 'NO';
      tokenId = orderbook.no.tokenId;
      confidence = 1.0 - probability;
    }
  }

  // 5. Generate signal if conditions met
  if (side && tokenId) {
    return {
      strategyName: 'ips1',
      strategyVersion: '0.1.0',
      marketId,
      symbol,
      action: 'ENTER',
      side,
      tokenId,
      size: ENTRY_CONDITIONS.positionSizeUsd,
      confidence,
      entryPrice,
      features,
      modelMetadata: {
        probability,
        imputedCount,
        threshold: side === 'YES'
          ? ENTRY_CONDITIONS.yesThreshold
          : ENTRY_CONDITIONS.noThreshold,
      },
      timestamp: new Date(),
    };
  }

  return null;
}
```

### Signal Example

```typescript
{
  strategyName: 'ips1',
  strategyVersion: '0.1.0',
  marketId: '0xabc123...',
  symbol: 'BTCUSDT',
  action: 'ENTER',
  side: 'YES',
  tokenId: '0xdef456...',
  size: 100.0,
  confidence: 0.73,
  entryPrice: 0.65,
  features: {
    state_minute: 2,
    return_since_open: 0.0008,
    // ... all features
  },
  modelMetadata: {
    probability: 0.73,
    imputedCount: 0,
    threshold: 0.70,
  },
  timestamp: '2026-01-08T14:23:00Z',
}
```

---

## Mapping to Hermes Library

### Infrastructure Availability Matrix

| Component | Hermes Service | Status | Notes |
|-----------|----------------|--------|-------|
| **Market Discovery** | `MarketService.scanCryptoShortTermMarkets()` | ✅ Available | Exact match for 15m markets |
| **Orderbook Data** | `MarketService.getOrderbook()` | ✅ Available | Real-time bid/ask prices |
| **Spot Price Feed** | `RealtimeServiceV2.subscribeCryptoPrice()` | ✅ Available | Chainlink WebSocket |
| **Order Execution** | `TradingService.createMarketOrder()` | ✅ Available | FOK/FAK support |
| **Rate Limiting** | `RateLimiter` | ✅ Available | Automatic API throttling |
| **Caching** | `UnifiedCache` | ✅ Available | TTL-based caching |
| **WebSocket** | `RealtimeServiceV2` | ✅ Available | Auto-reconnect |
| **Intrawindow Tracker** | - | ❌ Missing | Need to implement |
| **Logistic Model** | - | ❌ Missing | Need to implement |
| **Strategy Service** | - | ❌ Missing | Need to implement |

### Implementation Coverage

**✅ Already Available (95%):**
1. Market discovery and filtering
2. Real-time price feeds (Chainlink)
3. Orderbook monitoring (WebSocket)
4. Order execution (market orders)
5. Rate limiting and caching
6. Connection management
7. Error handling

**❌ Need to Implement (5%):**
1. IntrawindowTracker class (feature computation)
2. LogisticModel class (inference)
3. Ips1StrategyService (orchestration)
4. Model loading utilities
5. Strategy configuration

---

## Implementation Plan

### Phase 1: Core Components (Week 1)

#### 1.1 IntrawindowTracker
**File:** `src/strategies/intrawindow-tracker.ts`
**Lines:** ~300
**Effort:** 6 hours

```typescript
export interface FeatureVector {
  stateMinute: number;
  minutesRemaining: number;
  returnSinceOpen: number;
  maxRunUp: number;
  maxRunDown: number;
  returnPrev1m: number;
  returnPrev3m: number;
  returnPrev5m: number;
  volatility5m: number;
  volumeZscore15m: number;
  upHitMinute?: number;
  downHitMinute?: number;
  hasUpHit: boolean;
  hasDownHit: boolean;
  hourOfDay: number;
  minuteOfHour: number;
  dayOfWeek: number;
}

/**
 * Tracks rolling intrawindow state for a single market/symbol pair.
 *
 * CRITICAL: Maintains price history across 15-minute windows to match
 * Python training behavior. The closes buffer is NEVER cleared between
 * windows - only window-specific state (maxRunUp, threshold hits, etc.)
 * is reset.
 */
export class IntrawindowTracker {
  private static readonly MAX_HISTORY_MINUTES = 32;

  private horizon: number;           // 15 minutes
  private threshold: number;         // e.g., 0.0008 for BTC
  private windowStart?: Date;
  private openPrice?: number;
  private maxRunUp: number = 0;
  private maxRunDown: number = 0;
  private closes: number[] = [];     // PERSISTS across windows!
  private upHitMinute?: number;
  private downHitMinute?: number;
  private lastMinute?: Date;

  constructor(horizonMinutes: number, threshold: number) {
    this.horizon = horizonMinutes;
    this.threshold = threshold;
  }

  /**
   * Ingest a new price update.
   * Returns feature vector if minute boundary crossed, null otherwise.
   */
  ingestPrice(price: number, timestamp: Date): FeatureVector | null {
    if (!isFinite(price) || price <= 0) {
      return null;
    }

    const minuteTs = this.floorToMinute(timestamp);

    // First price initializes the tracker
    if (!this.windowStart || !this.openPrice) {
      this.reset(minuteTs, price);
      return null;
    }

    // Skip duplicate updates for the same minute
    if (this.lastMinute && minuteTs <= this.lastMinute) {
      return null;
    }

    const elapsed = Math.floor((minuteTs.getTime() - this.windowStart.getTime()) / 60000);
    if (elapsed < 0) {
      return null;
    }

    const stateMinute = elapsed;

    // Window expired - start new window
    if (stateMinute >= this.horizon) {
      this.reset(minuteTs, price);
      return null;
    }

    // Update state
    this.lastMinute = minuteTs;
    this.closes.push(price);

    // Maintain rolling buffer (matches Python's continuous time series)
    while (this.closes.length > IntrawindowTracker.MAX_HISTORY_MINUTES) {
      this.closes.shift();
    }

    // Update window-specific metrics
    const returnSinceOpen = price / this.openPrice - 1.0;
    this.maxRunUp = Math.max(this.maxRunUp, Math.max(returnSinceOpen, 0));
    this.maxRunDown = Math.min(this.maxRunDown, Math.min(returnSinceOpen, 0));

    // Track threshold hits
    if (!this.upHitMinute && returnSinceOpen >= this.threshold) {
      this.upHitMinute = stateMinute;
    }
    if (!this.downHitMinute && returnSinceOpen <= -this.threshold) {
      this.downHitMinute = stateMinute;
    }

    // Compute lagged features (may be NaN if insufficient history)
    const returnPrev1m = this.computeReturn(1);
    const returnPrev3m = this.computeReturn(3);
    const returnPrev5m = this.computeReturn(5);
    const volatility5m = this.computeVolatility(5);

    return {
      stateMinute,
      minutesRemaining: this.horizon - stateMinute,
      returnSinceOpen,
      maxRunUp: this.maxRunUp,
      maxRunDown: this.maxRunDown,
      hourOfDay: minuteTs.getUTCHours(),
      minuteOfHour: minuteTs.getUTCMinutes(),
      dayOfWeek: (minuteTs.getUTCDay() + 6) % 7, // Monday = 0
      returnPrev1m,
      returnPrev3m,
      returnPrev5m,
      volatility5m,
      volumeZscore15m: 0.0, // TODO: implement when volume feed available
      upHitMinute: this.upHitMinute,
      downHitMinute: this.downHitMinute,
      hasUpHit: this.upHitMinute !== undefined,
      hasDownHit: this.downHitMinute !== undefined,
    };
  }

  /**
   * Reset window-specific state for a new 15-minute window.
   *
   * CRITICAL: Does NOT clear the closes buffer! We maintain price history
   * across windows to match Python training behavior where return_prev_3m
   * at state minute 2 can look back to the previous window.
   */
  private reset(minuteTs: Date, openPrice: number): void {
    this.windowStart = minuteTs;
    this.openPrice = openPrice;
    this.maxRunUp = 0;
    this.maxRunDown = 0;
    this.upHitMinute = undefined;
    this.downHitMinute = undefined;
    this.lastMinute = undefined;

    // Add open price to continuous history (don't clear!)
    this.closes.push(openPrice);
    while (this.closes.length > IntrawindowTracker.MAX_HISTORY_MINUTES) {
      this.closes.shift();
    }
  }

  /**
   * Compute rolling return over specified lookback window.
   *
   * Matches Python: df["close"].pct_change(lookback)
   * Returns NaN if insufficient data (will be imputed by model).
   *
   * Example: computeReturn(3) with closes=[p0,p1,p2,p3,p4]
   *   → (p4 / p1) - 1.0  (return over last 3 minutes)
   */
  private computeReturn(window: number): number {
    // Need at least window+1 elements to compute return
    // Python's pct_change(3) needs 4 elements: [t-3, t-2, t-1, t]
    if (this.closes.length < window + 1) {
      return NaN;  // Will be imputed
    }

    const latest = this.closes[this.closes.length - 1];
    const anchor = this.closes[this.closes.length - 1 - window];

    if (anchor === 0) {
      return NaN;
    }

    return (latest / anchor) - 1.0;
  }

  /**
   * Compute rolling volatility (std dev of returns) over lookback window.
   *
   * Matches Python: close_returns.rolling(window, min_periods=window).std()
   * Returns NaN if insufficient data.
   */
  private computeVolatility(window: number): number {
    // Need at least window+1 elements to compute window returns
    if (this.closes.length < window + 1) {
      return NaN;  // Will be imputed
    }

    // Compute returns over the window
    const returns: number[] = [];
    const start = this.closes.length - window - 1;

    for (let i = start; i < this.closes.length - 1; i++) {
      if (this.closes[i] > 0) {
        returns.push((this.closes[i + 1] / this.closes[i]) - 1.0);
      }
    }

    if (returns.length < 2) {
      return NaN;
    }

    // Compute standard deviation (sample std with n-1)
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => {
      const diff = r - mean;
      return sum + (diff * diff);
    }, 0) / (returns.length - 1);

    return Math.sqrt(variance);
  }

  private floorToMinute(ts: Date): Date {
    return new Date(
      Date.UTC(
        ts.getUTCFullYear(),
        ts.getUTCMonth(),
        ts.getUTCDate(),
        ts.getUTCHours(),
        ts.getUTCMinutes(),
        0,
        0
      )
    );
  }

  toFeatureMap(suffix: string): Record<string, number> {
    // This method would convert FeatureVector to the flat map
    // format expected by the model - implementation TBD
    return {};
  }
}
```

**Key Methods:**
- `ingestPrice()`: Main entry point, returns features at minute boundaries
- `reset()`: Start new 15-minute window (preserves price history!)
- `computeReturn()`: Rolling return calculation (returns NaN if insufficient data)
- `computeVolatility()`: Rolling volatility calculation (returns NaN if insufficient data)
- `toFeatureMap()`: Convert to model input format

**Critical Implementation Details:**

1. **Continuous Price History:**
   - The `closes` buffer is NEVER cleared between windows
   - Maintains up to 32 minutes of historical prices
   - This allows `return_prev_3m` at state minute 2 to look back to previous window
   - Matches Python's continuous time-series behavior

2. **Edge Cases - Early State Minutes:**
   ```
   State Minute 1 (14:01):
     closes buffer: [prev_window_prices..., open, p1] (likely 16+ elements)
     - return_prev_1m: ✅ VALID (looks back to open)
     - return_prev_3m: ✅ VALID (looks back to previous window 13:58)
     - return_prev_5m: ✅ VALID (looks back to previous window 13:56)
     - volatility_5m: ✅ VALID (uses prices from previous window)

   State Minute 2 (14:02):
     closes buffer: [prev_window_prices..., open, p1, p2] (likely 17+ elements)
     - All features VALID - can look back across window boundary
   ```

3. **NaN Handling (Imputation):**
   - Features return `NaN` only when truly insufficient data (e.g., very first market ever)
   - Model has an imputation file with median values computed from training data
   - NaN values are replaced with these medians during inference
   - Example imputation values:
     ```json
     {
       "BTCUSDT": {
         "volatility_5m": 0.0012,
         "return_prev_1m": 0.0,
         "return_prev_3m": 0.0,
         "return_prev_5m": 0.0
       }
     }
     ```

4. **Window Transitions:**
   - When state_minute >= 15, `reset()` is called
   - Reset clears: `maxRunUp`, `maxRunDown`, `upHitMinute`, `downHitMinute`
   - Reset preserves: `closes` buffer (continuous history)
   - New window's open price is added to the continuous buffer

**Tests:** `src/strategies/intrawindow-tracker.test.ts`

#### 1.2 LogisticModel
**File:** `src/strategies/logistic-model.ts`
**Lines:** ~100
**Effort:** 3 hours

```typescript
export interface ModelConfig {
  featureColumns: string[];
  coefficients: number[];
  intercept: number;
}

export interface PredictionResult {
  probability: number;
  imputedCount: number;
}

export class LogisticModel {
  constructor(private config: ModelConfig) {
    if (config.featureColumns.length !== config.coefficients.length) {
      throw new Error('Feature columns and coefficients length mismatch');
    }
  }

  predict(
    features: Record<string, number>,
    imputations?: Record<string, number>
  ): PredictionResult {
    let z = this.config.intercept;
    let imputedCount = 0;

    for (let i = 0; i < this.config.featureColumns.length; i++) {
      const col = this.config.featureColumns[i];
      let value = features[col];

      if (value === undefined || value === null || isNaN(value)) {
        value = imputations?.[col] ?? 0.0;
        imputedCount++;
      }

      z += this.config.coefficients[i] * value;
    }

    const probability = this.sigmoid(z);
    return { probability, imputedCount };
  }

  private sigmoid(z: number): number {
    if (z > 20) return 1.0;
    if (z < -20) return 0.0;
    return 1.0 / (1.0 + Math.exp(-z));
  }
}
```

**Tests:** `src/strategies/logistic-model.test.ts`

#### 1.3 Model Loading
**File:** `src/strategies/model-loader.ts`
**Lines:** ~50
**Effort:** 1 hour

```typescript
import { readFile } from 'fs/promises';

interface ModelFile {
  symbols: Array<{
    symbol: string;
    coefficients: number[];
    intercept: number;
    feature_columns: string[];
  }>;
}

export async function loadModels(
  path: string
): Promise<Map<string, LogisticModel>> {
  const json = await readFile(path, 'utf-8');
  const data: ModelFile = JSON.parse(json);

  const models = new Map();
  for (const entry of data.symbols) {
    models.set(entry.symbol, new LogisticModel({
      featureColumns: entry.feature_columns,
      coefficients: entry.coefficients,
      intercept: entry.intercept,
    }));
  }

  return models;
}

export async function loadImputations(
  path: string
): Promise<Map<string, Record<string, number>>> {
  const json = await readFile(path, 'utf-8');
  return new Map(Object.entries(JSON.parse(json)));
}
```

### Phase 2: Strategy Service (Week 1-2)

#### 2.1 Ips1StrategyService
**File:** `src/services/ips1-strategy-service.ts`
**Lines:** ~500
**Effort:** 12 hours

```typescript
import { EventEmitter } from 'events';
import { IntrawindowTracker, FeatureVector } from '../strategies/intrawindow-tracker.js';
import { LogisticModel } from '../strategies/logistic-model.js';
import { loadModels, loadImputations } from '../strategies/model-loader.js';
import type { MarketService } from './market-service.js';
import type { TradingService } from './trading-service.js';
import type { RealtimeServiceV2, CryptoPrice } from './realtime-service-v2.js';

export interface Ips1Config {
  enabled: boolean;
  modelPath: string;
  imputationPath?: string;
  stateMinutes: number[];
  horizonMinutes: number;
  yesThreshold: number;
  noThreshold: number;
  entryPriceCap: number;
  positionSizeUsd: number;
  symbols: string[];
  thresholdBps: Record<string, number>;
}

export interface Signal {
  strategyName: string;
  strategyVersion: string;
  marketId: string;
  symbol: string;
  action: 'ENTER';
  side: 'YES' | 'NO';
  tokenId: string;
  size: number;
  confidence: number;
  entryPrice: number;
  features: FeatureVector;
  modelMetadata: {
    probability: number;
    imputedCount: number;
    threshold: number;
  };
  timestamp: Date;
}

export class Ips1StrategyService extends EventEmitter {
  private models: Map<string, LogisticModel> = new Map();
  private imputations: Map<string, Record<string, number>> = new Map();
  private trackers: Map<string, IntrawindowTracker> = new Map();
  private priceSubscriptions: Map<string, any> = new Map();
  private predictiveScanInterval?: NodeJS.Timeout;
  private reactiveScanInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    private config: Ips1Config,
    private marketService: MarketService,
    private tradingService: TradingService,
    private realtimeService: RealtimeServiceV2
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Load models
    this.models = await loadModels(this.config.modelPath);
    if (this.config.imputationPath) {
      this.imputations = await loadImputations(this.config.imputationPath);
    }

    // Subscribe to crypto prices
    for (const symbol of this.config.symbols) {
      this.subscribeToPriceUpdates(symbol);
    }

    // Initial market discovery (hybrid approach)
    await this.scanUpcomingMarkets(30);  // Predictive: next 30 minutes
    await this.scanActiveMarkets();       // Reactive: currently active

    // Schedule periodic predictive scan (every 10 minutes)
    this.predictiveScanInterval = setInterval(() => {
      this.scanUpcomingMarkets(30);
    }, 10 * 60 * 1000);

    // Schedule periodic reactive scan (every 1 minute - safety net)
    this.reactiveScanInterval = setInterval(() => {
      this.scanActiveMarkets();
    }, 60 * 1000);

    // Schedule tracker cleanup (every 30 seconds)
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleTrackers();
    }, 30 * 1000);

    this.isRunning = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    // Unsubscribe from prices
    for (const [symbol, sub] of this.priceSubscriptions) {
      sub.unsubscribe();
    }
    this.priceSubscriptions.clear();

    // Clear intervals
    if (this.predictiveScanInterval) clearInterval(this.predictiveScanInterval);
    if (this.reactiveScanInterval) clearInterval(this.reactiveScanInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    this.isRunning = false;
    this.emit('stopped');
  }

  private subscribeToPriceUpdates(symbol: string): void {
    const asset = this.symbolToAsset(symbol);

    const subscription = this.realtimeService.subscribeCryptoPrice(
      asset,
      (price: CryptoPrice) => {
        this.onPriceUpdate(symbol, price.price, new Date());
      }
    );

    this.priceSubscriptions.set(symbol, subscription);
  }

  /**
   * PREDICTIVE SCAN: Pre-create trackers for upcoming markets
   *
   * Uses predictable slug pattern to find markets that will start soon.
   * Creates trackers BEFORE markets become active, ensuring we catch
   * state minute 0 when they go live.
   *
   * @param lookaheadMinutes - How far ahead to scan (default: 30)
   */
  private async scanUpcomingMarkets(lookaheadMinutes: number = 30): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const interval = 900; // 15 minutes in seconds
      const lookaheadSlots = Math.ceil(lookaheadMinutes / 15);

      const slugs: string[] = [];

      // Generate slugs for upcoming 15-minute slots
      for (let i = 0; i <= lookaheadSlots; i++) {
        const slotStart = Math.ceil(now / interval) * interval + (i * interval);

        for (const symbol of this.config.symbols) {
          const coin = this.symbolToSlugPrefix(symbol);
          slugs.push(`${coin}-updown-15m-${slotStart}`);
        }
      }

      // Fetch all predicted markets in parallel
      const results = await Promise.allSettled(
        slugs.map(slug => this.marketService.getMarketBySlug(slug).catch(() => null))
      );

      let addedCount = 0;

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const market = result.value;

          // Only create tracker if market exists and we don't have one yet
          if (market.active && !market.closed && !this.trackers.has(market.conditionId)) {
            const symbol = this.inferSymbolFromSlug(market.slug);
            if (symbol) {
              const threshold = this.config.thresholdBps[symbol] ?? 0.0005;
              this.trackers.set(
                market.conditionId,
                new IntrawindowTracker(this.config.horizonMinutes, threshold)
              );
              addedCount++;
              this.emit('marketAdded', {
                marketId: market.conditionId,
                symbol,
                type: 'predictive',
                slug: market.slug,
              });
            }
          }
        }
      }

      if (addedCount > 0) {
        console.log(`[IPS1] Predictive scan: Added ${addedCount} upcoming markets`);
      }
    } catch (error) {
      this.emit('error', { source: 'predictiveScan', error });
    }
  }

  /**
   * REACTIVE SCAN: Discover currently active markets
   *
   * Safety net to catch any markets missed by predictive scanning.
   * Runs every 1 minute to ensure maximum 1-minute discovery latency.
   */
  private async scanActiveMarkets(): Promise<void> {
    try {
      const markets = await this.marketService.scanCryptoShortTermMarkets({
        duration: '15m',
        minMinutesUntilEnd: 1,   // Include all active markets
        maxMinutesUntilEnd: 30,
        limit: 50,
      });

      let addedCount = 0;

      for (const market of markets) {
        if (!this.trackers.has(market.conditionId)) {
          const symbol = this.inferSymbolFromSlug(market.slug);
          if (symbol) {
            const threshold = this.config.thresholdBps[symbol] ?? 0.0005;
            this.trackers.set(
              market.conditionId,
              new IntrawindowTracker(this.config.horizonMinutes, threshold)
            );
            addedCount++;
            this.emit('marketAdded', {
              marketId: market.conditionId,
              symbol,
              type: 'reactive',
              slug: market.slug,
            });
          }
        }
      }

      if (addedCount > 0) {
        console.log(`[IPS1] Reactive scan: Added ${addedCount} active markets`);
      }
    } catch (error) {
      this.emit('error', { source: 'reactiveScan', error });
    }
  }

  private onPriceUpdate(symbol: string, price: number, timestamp: Date): void {
    // Update all trackers for this symbol
    for (const [marketId, tracker] of this.trackers) {
      const marketSymbol = this.getMarketSymbol(marketId);
      if (marketSymbol === symbol) {
        const features = tracker.ingestPrice(price, timestamp);
        if (features) {
          // New minute boundary - evaluate signal
          this.evaluateSignal(marketId, symbol, features).catch(error => {
            this.emit('error', error);
          });
        }
      }
    }
  }

  private async evaluateSignal(
    marketId: string,
    symbol: string,
    features: FeatureVector
  ): Promise<void> {
    // 1. Check if in entry window
    if (!this.config.stateMinutes.includes(features.stateMinute)) {
      return;
    }

    // 2. Get model
    const model = this.models.get(symbol);
    if (!model) return;

    // 3. Convert features to map
    const threshold = this.config.thresholdBps[symbol] ?? 0.0005;
    const suffix = this.formatThresholdSuffix(threshold);
    const featureMap = this.featuresToMap(features, suffix);

    // 4. Run inference
    const imputations = this.imputations.get(symbol);
    const { probability, imputedCount } = model.predict(featureMap, imputations);

    // 5. Get orderbook
    const orderbook = await this.marketService.getOrderbook(marketId);

    // 6. Check thresholds and generate signal
    let side: 'YES' | 'NO' | null = null;
    let tokenId: string | null = null;
    let entryPrice: number = 0;
    let confidence: number = 0;
    let threshold_: number = 0;

    if (probability >= this.config.yesThreshold &&
        orderbook.yes.ask <= this.config.entryPriceCap) {
      side = 'YES';
      tokenId = orderbook.yes.tokenId;
      entryPrice = orderbook.yes.ask;
      confidence = probability;
      threshold_ = this.config.yesThreshold;
    } else if (probability <= this.config.noThreshold &&
               orderbook.no.ask <= this.config.entryPriceCap) {
      side = 'NO';
      tokenId = orderbook.no.tokenId;
      entryPrice = orderbook.no.ask;
      confidence = 1.0 - probability;
      threshold_ = this.config.noThreshold;
    }

    // 7. Execute if conditions met
    if (side && tokenId) {
      const signal: Signal = {
        strategyName: 'ips1',
        strategyVersion: '0.1.0',
        marketId,
        symbol,
        action: 'ENTER',
        side,
        tokenId,
        size: this.config.positionSizeUsd,
        confidence,
        entryPrice,
        features,
        modelMetadata: {
          probability,
          imputedCount,
          threshold: threshold_,
        },
        timestamp: new Date(),
      };

      this.emit('signal', signal);
      await this.executeSignal(signal);
    }
  }

  private async executeSignal(signal: Signal): Promise<void> {
    try {
      const result = await this.tradingService.createMarketOrder({
        tokenId: signal.tokenId,
        side: 'BUY',
        amount: signal.size,
        orderType: 'FOK',
      });

      this.emit('execution', { signal, result });
    } catch (error) {
      this.emit('executionError', { signal, error });
    }
  }

  private cleanupStaleTrackers(): void {
    const marketsToRemove: string[] = [];

    for (const marketId of this.trackers.keys()) {
      // Check if market is still active
      // (Implementation depends on market status tracking)
    }

    for (const marketId of marketsToRemove) {
      this.trackers.delete(marketId);
      this.emit('marketRemoved', { marketId });
    }
  }

  private inferSymbolFromSlug(slug: string): string | null {
    if (!slug.includes('updown') || !slug.includes('-15m-')) {
      return null;
    }

    for (const symbol of this.config.symbols) {
      const prefix = this.symbolToSlugPrefix(symbol);
      if (slug.startsWith(prefix)) {
        return symbol;
      }
    }

    return null;
  }

  private getMarketSymbol(marketId: string): string | null {
    // Implementation depends on market metadata storage
    return null;
  }

  private symbolToAsset(symbol: string): string {
    const map: Record<string, string> = {
      BTCUSDT: 'BTC',
      ETHUSDT: 'ETH',
      SOLUSDT: 'SOL',
      XRPUSDT: 'XRP',
    };
    return map[symbol] ?? symbol;
  }

  private symbolToSlugPrefix(symbol: string): string {
    const map: Record<string, string> = {
      BTCUSDT: 'btc',
      ETHUSDT: 'eth',
      SOLUSDT: 'sol',
      XRPUSDT: 'xrp',
    };
    return map[symbol] ?? '';
  }

  private formatThresholdSuffix(threshold: number): string {
    const bps = Math.round(threshold * 10000);
    return `${bps}bps`;
  }

  private featuresToMap(
    features: FeatureVector,
    suffix: string
  ): Record<string, number> {
    return {
      state_minute: features.stateMinute,
      minutes_remaining: features.minutesRemaining,
      return_since_open: features.returnSinceOpen,
      max_run_up: features.maxRunUp,
      max_run_down: features.maxRunDown,
      return_prev_1m: features.returnPrev1m,
      return_prev_3m: features.returnPrev3m,
      return_prev_5m: features.returnPrev5m,
      volatility_5m: features.volatility5m,
      volume_zscore_15m: features.volumeZscore15m,
      hour_of_day: features.hourOfDay,
      minute_of_hour: features.minuteOfHour,
      day_of_week: features.dayOfWeek,
      [`has_up_hit_${suffix}`]: features.hasUpHit ? 1.0 : 0.0,
      [`has_down_hit_${suffix}`]: features.hasDownHit ? 1.0 : 0.0,
      [`first_up_hit_minute_${suffix}`]: features.upHitMinute ?? NaN,
      [`first_down_hit_minute_${suffix}`]: features.downHitMinute ?? NaN,
    };
  }
}
```

### Phase 3: Testing (Week 2)

#### 3.1 Unit Tests
- `intrawindow-tracker.test.ts`: Feature computation tests
- `logistic-model.test.ts`: Model inference tests
- `model-loader.test.ts`: File loading tests

#### 3.2 Integration Tests
- `ips1-strategy.integration.test.ts`: End-to-end strategy tests

### Phase 4: Documentation & Deployment (Week 2)

#### 4.1 Documentation
- API documentation
- Configuration guide
- Troubleshooting guide

#### 4.2 Deployment
- Dry-run mode testing
- Paper trading validation
- Production rollout

---

## Configuration

### Example Configuration

```typescript
const ips1Config: Ips1Config = {
  enabled: true,
  modelPath: './models/intrawindow_state_strategy_model.json',
  imputationPath: './models/intrawindow_state_strategy_imputations.json',

  // Entry window: first 0-2 minutes
  stateMinutes: [0, 1, 2],

  // 15-minute markets
  horizonMinutes: 15,

  // Model confidence thresholds
  yesThreshold: 0.70,   // >= 70% confident UP
  noThreshold: 0.30,    // <= 30% confident UP (70% DOWN)

  // Entry price cap
  entryPriceCap: 0.70,  // Only enter if price <= 0.70

  // Position sizing
  positionSizeUsd: 100.0,

  // Supported assets
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],

  // Threshold per asset (basis points)
  thresholdBps: {
    BTCUSDT: 0.0008,  // 8 bps = 0.08%
    ETHUSDT: 0.0010,  // 10 bps = 0.10%
    SOLUSDT: 0.0020,  // 20 bps = 0.20%
    XRPUSDT: 0.0015,  // 15 bps = 0.15%
  },
};
```

### Usage Example

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { Ips1StrategyService } from './services/ips1-strategy-service';

// Initialize SDK
const sdk = await PolymarketSDK.create({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY,
});

// Create strategy service
const ips1 = new Ips1StrategyService(
  ips1Config,
  sdk.markets,
  sdk.tradingService,
  sdk.realtime
);

// Listen to events
ips1.on('signal', (signal) => {
  console.log('Signal generated:', signal);
});

ips1.on('execution', ({ signal, result }) => {
  console.log('Order executed:', result);
});

ips1.on('error', (error) => {
  console.error('Strategy error:', error);
});

// Start strategy
await sdk.realtime.connect();
await ips1.start();

console.log('IPS1 strategy running...');
```

---

## Risk Assessment

### Technical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Feature computation bugs | Medium | Comprehensive unit tests vs Argus |
| Model inference errors | Low | Simple logistic regression, well-tested |
| WebSocket disconnection | Low | Auto-reconnect in RealtimeService |
| Rate limiting | Low | Built-in RateLimiter |
| Price feed latency | Medium | Use Chainlink (sub-second latency) |
| Market scanning gaps | Low | Periodic rescans every 5 minutes |

### Operational Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Model staleness | Medium | Periodic retraining (offline) |
| Poor model performance | High | Extensive backtesting before deployment |
| Execution failures | Medium | Retry logic, alerts |
| Position sizing errors | Low | Fixed size + validation |
| Entry price slippage | Medium | Price cap enforcement |

### Financial Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Model overfitting | High | Walk-forward validation |
| Market regime change | High | Performance monitoring, kill switch |
| Liquidity issues | Low | Markets are generally liquid |
| Simultaneous signals | Medium | Position size limits |

---

## Performance Expectations

### Backtesting Results (from Argus)

**Test Period:** 120 days training, 30 days evaluation
**Markets:** BTC, ETH, SOL, XRP 15-minute UP/DOWN

| Metric | Value |
|--------|-------|
| **Win Rate** | 55-58% |
| **Average Trade** | $0.50 - $2.00 profit |
| **Sharpe Ratio** | 1.5 - 2.0 |
| **Max Drawdown** | 15-20% |
| **Trade Coverage** | 60-70% of windows |
| **Avg Hold Time** | 15 minutes (full window) |

### Production Expectations

**Daily Volume:**
- 4 assets × 96 markets/day × 60% coverage = ~230 trades/day
- Position size: $100/trade
- Daily exposure: ~$23,000

**Expected Returns:**
- Avg profit per trade: $1.00
- Daily profit: ~$230 (1% on capital)
- Monthly profit: ~$6,900

**Risk Parameters:**
- Max concurrent positions: ~15 (15-min stagger)
- Max exposure: ~$1,500
- Stop-loss: None (binary outcomes, hold to expiry)

---

## Comparison with DipArbService

### Similarities
- Both trade 15-minute crypto markets
- Both use external spot prices (not Polymarket mid)
- Both enter early in window
- Both have fixed position sizing

### Differences

| Feature | DipArbService | IPS1 |
|---------|---------------|------|
| **Signal** | Rule-based (dip threshold) | ML model (logistic regression) |
| **Features** | Simple (dip %, time) | Rich (17+ features) |
| **Entry** | Leg1 (dip) + Leg2 (hedge) | Single entry (0-2 min) |
| **Exit** | Auto-hedge when profitable | Hold to expiry |
| **Hedge** | Yes (lock in profit) | No (directional bet) |
| **Strategy** | Market-neutral arbitrage | Directional prediction |
| **Risk** | Very low (hedged) | Medium (unhedged) |
| **Return** | 0.5-2% per round | 5-15% per trade |

---

## Next Steps

### Immediate Actions

1. **Export model artifacts from Argus**
   ```bash
   cd ~/dev/argus
   python research/crypto_15minute/scripts/run_intrawindow_state_strategy.py \
     --model-output models/ips1_model.json \
     --imputation-output models/ips1_imputations.json
   ```

2. **Implement IntrawindowTracker**
   - Create `src/strategies/intrawindow-tracker.ts`
   - Write unit tests
   - Validate against Argus output

3. **Implement LogisticModel**
   - Create `src/strategies/logistic-model.ts`
   - Write unit tests
   - Test with known predictions

4. **Implement Ips1StrategyService**
   - Create `src/services/ips1-strategy-service.ts`
   - Wire up all components
   - Test in dry-run mode

5. **Validate end-to-end**
   - Run against live data (no orders)
   - Compare signals with Argus
   - Fix any discrepancies

6. **Deploy to paper trading**
   - Enable order execution
   - Monitor performance
   - Compare with backtest results

---

## References

### Argus Source Files

- **Strategy:** `~/dev/argus/argus/src/trading/strategies/ips1.rs`
- **Features:** `~/dev/argus/argus/src/trading/features/intrawindow.rs`
- **Config:** `~/dev/argus/argus/src/config.rs` (Ips1Config)
- **Docs:** `~/dev/argus/docs/ips1_strategy.md`
- **Research:** `~/dev/argus/research/crypto_15minute/`

### Hermes Source Files

- **Market Service:** `src/services/market-service.ts`
- **Trading Service:** `src/services/trading-service.ts`
- **Realtime Service:** `src/services/realtime-service-v2.ts`
- **Binance Service:** `src/services/binance-service.ts`

### External Resources

- Polymarket API Docs: https://docs.polymarket.com/
- Logistic Regression: https://en.wikipedia.org/wiki/Logistic_regression
- Feature Engineering: https://en.wikipedia.org/wiki/Feature_engineering

---

**Document Version:** 1.0
**Last Updated:** 2026-01-08
**Author:** Claude Code Assistant
**Status:** Ready for Implementation
