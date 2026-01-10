# Crypto15ML Strategy

15-minute binary crypto market ML prediction strategy for Polymarket.

## Overview

Crypto15ML is a machine learning-based trading strategy that predicts the direction of crypto prices (BTC, ETH, SOL, XRP) over 15-minute windows on Polymarket's binary "Up/Down" markets.

### How It Works

1. **Market Discovery** - Automatically discovers active 15-minute crypto markets
2. **Price Ingestion** - Subscribes to real-time crypto price feeds via WebSocket
3. **Feature Computation** - Computes ML features at minute boundaries (returns, volatility, threshold hits)
4. **Signal Generation** - Uses trained logistic regression model to predict UP/DOWN probability
5. **Trade Execution** - Executes market orders when confidence thresholds are met

### Supported Markets

| Asset | Symbol | Threshold (BPS) |
|-------|--------|-----------------|
| Bitcoin | BTCUSDT | 8 (0.08%) |
| Ethereum | ETHUSDT | 10 (0.10%) |
| Solana | SOLUSDT | 20 (0.20%) |
| XRP | XRPUSDT | 15 (0.15%) |

## Requirements

- Node.js 18+
- Polymarket wallet with USDC.e balance
- Trained model files (from Argus)
- WebSocket connection for real-time prices

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Required
POLYMARKET_PRIVATE_KEY=0x...

# Crypto15ML settings
CRYPTO15ML_ENABLED=true
CRYPTO15ML_DRY_RUN=true  # Start with paper trading
CRYPTO15ML_POSITION_SIZE=50
```

### 3. Add Model Files

Place your trained model files in the `models/` directory:

```
models/
  crypto15ml_model.json
  crypto15ml_imputations.json
```

See [MODEL_EXPORT.md](./MODEL_EXPORT.md) for export instructions.

### 4. Run the Strategy

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { Crypto15MLStrategyService } from '@catalyst-team/poly-sdk';
import { crypto15mlConfig } from './config/crypto15ml.config';

// Initialize SDK
const sdk = await PolymarketSDK.create({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY,
});

// Create strategy service
const strategy = new Crypto15MLStrategyService(
  sdk.markets,
  sdk.tradingService,
  sdk.realtime,
  crypto15mlConfig
);

// Listen for events
strategy.on('signal', (signal) => {
  console.log(`Signal: ${signal.side} ${signal.asset} @ ${signal.probability.toFixed(2)}`);
});

strategy.on('execution', (result) => {
  console.log(`Execution: ${result.orderResult.success ? 'SUCCESS' : 'FAILED'}`);
});

strategy.on('paperPosition', (position) => {
  console.log(`Paper Position: ${position.side} ${position.symbol} @ ${position.entryPrice}`);
});

// Start the strategy
await strategy.start();

// Run until interrupted
process.on('SIGINT', () => {
  strategy.stop();
  sdk.stop();
  process.exit(0);
});
```

## Configuration

See [CONFIGURATION.md](./CONFIGURATION.md) for detailed configuration options.

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Enable/disable strategy |
| `dryRun` | `true` | Paper trading mode |
| `positionSizeUsd` | `100` | Position size per trade |
| `yesThreshold` | `0.70` | Probability threshold for YES |
| `noThreshold` | `0.30` | Probability threshold for NO |
| `stateMinutes` | `[0,1,2]` | Minutes when signals can fire |

## Dry-Run Mode

Always start with `dryRun: true` to validate your setup:

```typescript
// In dry-run mode, the strategy:
// - Generates signals normally
// - Records "paper" positions instead of real trades
// - Tracks P&L based on market outcomes
// - Emits 'paperPosition' and 'paperSettlement' events

strategy.on('paperSettlement', (settlement) => {
  console.log(`Settlement: ${settlement.won ? 'WIN' : 'LOSS'} $${settlement.pnl.toFixed(2)}`);
});

// Get paper trading stats
const stats = strategy.getPaperTradingStats();
console.log(`Positions: ${stats.positionCount}, P&L: $${stats.cumulativePnL.toFixed(2)}`);
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `signal` | `Signal` | New trading signal generated |
| `execution` | `ExecutionResult` | Trade execution result |
| `marketAdded` | `MarketAddedEvent` | New market being tracked |
| `marketRemoved` | `MarketRemovedEvent` | Market expired/removed |
| `paperPosition` | `PaperPosition` | Paper position recorded (dry-run) |
| `paperSettlement` | `PaperSettlement` | Paper position settled (dry-run) |
| `error` | `Error` | Error occurred |

## Monitoring

See [OPERATIONS.md](./OPERATIONS.md) for monitoring and operational guidance.

### Railway Log Filtering

```bash
# Filter by event type
level:INFO event:signal_generated

# Filter by symbol
symbol:BTCUSDT

# Filter errors only
level:ERROR

# Paper trading events
event:paper_position OR event:paper_settlement
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Crypto15MLStrategyService                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐   │
│  │   Market    │    │    Price     │    │    Signal     │   │
│  │  Discovery  │───▶│  Ingestion   │───▶│  Generation   │   │
│  └─────────────┘    └──────────────┘    └───────────────┘   │
│         │                  │                    │            │
│         ▼                  ▼                    ▼            │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐   │
│  │  GammaAPI   │    │  WebSocket   │    │   LR Model    │   │
│  │  (Markets)  │    │  (Prices)    │    │  (Inference)  │   │
│  └─────────────┘    └──────────────┘    └───────────────┘   │
│                            │                    │            │
│                            ▼                    ▼            │
│                     ┌──────────────┐    ┌───────────────┐   │
│                     │   Feature    │    │    Trade      │   │
│                     │   Engine     │    │  Execution    │   │
│                     └──────────────┘    └───────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Related Documentation

- [CONFIGURATION.md](./CONFIGURATION.md) - All configuration options
- [OPERATIONS.md](./OPERATIONS.md) - Operational guide
- [MODEL_EXPORT.md](./MODEL_EXPORT.md) - Model export from Argus
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Railway deployment guide

## Troubleshooting

### Common Issues

**Strategy not starting:**
- Verify `CRYPTO15ML_ENABLED=true`
- Check model files exist in `models/` directory
- Ensure RealtimeService is connected before starting

**No signals generated:**
- Check if current minute is in `stateMinutes` (default: 0, 1, 2)
- Verify model thresholds aren't too strict
- Ensure price feeds are working (check WebSocket connection)

**Order execution failures:**
- Check USDC.e balance on Polymarket
- Verify wallet has approved CTF contracts
- Check for rate limiting issues

See [OPERATIONS.md](./OPERATIONS.md) for more troubleshooting guidance.
