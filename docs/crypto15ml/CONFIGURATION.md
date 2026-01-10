# Crypto15ML Configuration Guide

Complete guide to configuring the Crypto15ML strategy.

## Configuration Methods

### 1. Environment Variables (Recommended for Production)

Set environment variables in your `.env` file or deployment platform:

```bash
CRYPTO15ML_ENABLED=true
CRYPTO15ML_DRY_RUN=false
CRYPTO15ML_POSITION_SIZE=100
```

### 2. Config File

Edit `config/crypto15ml.config.ts` directly for custom logic:

```typescript
export const crypto15mlConfig: Crypto15MLConfig = {
  enabled: true,
  dryRun: false,
  positionSizeUsd: 100,
  // ... other options
};
```

### 3. Programmatic Configuration

Pass config directly when creating the service:

```typescript
const strategy = new Crypto15MLStrategyService(
  marketService,
  tradingService,
  realtimeService,
  {
    enabled: true,
    dryRun: false,
    positionSizeUsd: 100,
    // ... other options
  }
);
```

## Configuration Options

### Core Settings

| Option | Type | Default | Env Variable | Description |
|--------|------|---------|--------------|-------------|
| `enabled` | `boolean` | `false` | `CRYPTO15ML_ENABLED` | Enable/disable the strategy |
| `dryRun` | `boolean` | `true` | `CRYPTO15ML_DRY_RUN` | Paper trading mode |
| `debug` | `boolean` | `false` | `CRYPTO15ML_DEBUG` | Enable verbose logging |

### Model Paths

| Option | Type | Default | Env Variable | Description |
|--------|------|---------|--------------|-------------|
| `modelPath` | `string` | `./models/crypto15ml_model.json` | `CRYPTO15ML_MODEL_PATH` | Path to model coefficients |
| `imputationPath` | `string` | `./models/crypto15ml_imputations.json` | `CRYPTO15ML_IMPUTATION_PATH` | Path to imputation values |

### Signal Thresholds

| Option | Type | Default | Env Variable | Description |
|--------|------|---------|--------------|-------------|
| `yesThreshold` | `number` | `0.70` | `CRYPTO15ML_YES_THRESHOLD` | Minimum probability for YES signal |
| `noThreshold` | `number` | `0.30` | `CRYPTO15ML_NO_THRESHOLD` | Maximum probability for NO signal |
| `entryPriceCap` | `number` | `0.70` | `CRYPTO15ML_ENTRY_PRICE_CAP` | Maximum acceptable entry price |

### Position Sizing

| Option | Type | Default | Env Variable | Description |
|--------|------|---------|--------------|-------------|
| `positionSizeUsd` | `number` | `100` | `CRYPTO15ML_POSITION_SIZE` | Position size per trade in USD |

### Timing

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `stateMinutes` | `number[]` | `[0, 1, 2]` | Minutes within window when signals can fire |
| `horizonMinutes` | `number` | `15` | Prediction horizon (matches market duration) |

### Symbols & Thresholds

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `symbols` | `string[]` | `['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']` | Binance symbols to track |
| `thresholdBps` | `Record<string, number>` | See below | Per-asset threshold in basis points |

Default threshold values:

```typescript
thresholdBps: {
  BTC: 0.0008,  // 8 bps (0.08%)
  ETH: 0.0010,  // 10 bps (0.10%)
  SOL: 0.0020,  // 20 bps (0.20%)
  XRP: 0.0015,  // 15 bps (0.15%)
}
```

### Advanced Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logger` | `IStrategyLogger` | Auto-created | Custom logger for dependency injection |

## Environment-Specific Settings

### Development

```bash
CRYPTO15ML_ENABLED=true
CRYPTO15ML_DRY_RUN=true
CRYPTO15ML_DEBUG=true
CRYPTO15ML_POSITION_SIZE=10
```

### Staging

```bash
CRYPTO15ML_ENABLED=true
CRYPTO15ML_DRY_RUN=true
CRYPTO15ML_DEBUG=false
CRYPTO15ML_POSITION_SIZE=50
```

### Production

```bash
CRYPTO15ML_ENABLED=true
CRYPTO15ML_DRY_RUN=false
CRYPTO15ML_DEBUG=false
CRYPTO15ML_POSITION_SIZE=100
CRYPTO15ML_YES_THRESHOLD=0.75
CRYPTO15ML_NO_THRESHOLD=0.25
```

## Threshold Tuning

### Signal Thresholds

The `yesThreshold` and `noThreshold` control signal generation:

```
Probability: 0.0 ◄───────────────────────────────────► 1.0
              │                                       │
              └─── NO Signal ───┘ │ └─── YES Signal ──┘
                                  │
                    (probability <= 0.30)  (probability >= 0.70)
                                  │
                         No Signal Zone
                         (0.30 < p < 0.70)
```

**Higher thresholds** = fewer signals, higher confidence
**Lower thresholds** = more signals, lower confidence

### Entry Price Cap

The `entryPriceCap` prevents buying expensive positions:

```typescript
// If YES signal but price > 0.70, trade is rejected
// This protects against unfavorable risk/reward

// Example:
// YES signal, price = 0.65 → Trade executed
// YES signal, price = 0.75 → Trade rejected
```

### Recommended Settings by Risk Profile

**Conservative:**
```typescript
yesThreshold: 0.75,
noThreshold: 0.25,
entryPriceCap: 0.65,
positionSizeUsd: 50,
```

**Moderate (Default):**
```typescript
yesThreshold: 0.70,
noThreshold: 0.30,
entryPriceCap: 0.70,
positionSizeUsd: 100,
```

**Aggressive:**
```typescript
yesThreshold: 0.65,
noThreshold: 0.35,
entryPriceCap: 0.75,
positionSizeUsd: 200,
```

## State Minutes

The `stateMinutes` array controls when signals can be generated within each 15-minute window:

```
Window Timeline (15 minutes):
Minute: 0   1   2   3   4   5   6   7   8   9  10  11  12  13  14
        │   │   │   │   │   │   │   │   │   │   │   │   │   │   │
        └───┴───┴───┘                                           │
        Signal Zone                                           End
        (stateMinutes: [0, 1, 2])
```

**Why early minutes?**
- More time for position to play out
- Better risk/reward ratio
- Historical data shows higher accuracy in early minutes

## Validation

The config is validated on strategy startup. Invalid values throw errors:

```typescript
// These will throw:
positionSizeUsd: -10        // Must be positive
yesThreshold: 1.5           // Must be 0-1
noThreshold: 0.80           // Must be < yesThreshold
stateMinutes: [0, 15]       // Values must be 0-14
symbols: []                 // Cannot be empty
```

## Custom Logger

For testing or custom logging needs:

```typescript
import { IStrategyLogger } from '@catalyst-team/poly-sdk';

const customLogger: IStrategyLogger = {
  info: (event, context) => console.log(event, context),
  warn: (event, context) => console.warn(event, context),
  error: (event, context) => console.error(event, context),
  isEnabled: () => true,
};

const strategy = new Crypto15MLStrategyService(
  marketService,
  tradingService,
  realtimeService,
  {
    ...crypto15mlConfig,
    logger: customLogger,
  }
);
```

## Type Reference

```typescript
interface Crypto15MLConfig {
  enabled: boolean;
  modelPath: string;
  imputationPath: string;
  stateMinutes: number[];
  horizonMinutes: number;
  yesThreshold: number;
  noThreshold: number;
  entryPriceCap: number;
  positionSizeUsd: number;
  symbols: string[];
  thresholdBps: Record<string, number>;
  debug?: boolean;
  dryRun?: boolean;
  logger?: IStrategyLogger;
}
```
