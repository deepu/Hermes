# Crypto15ML Operations Guide

Operational procedures for running and monitoring the Crypto15ML strategy.

## Starting the Strategy

### Prerequisites Checklist

- [ ] Model files in place (`models/crypto15ml_model.json`, `models/crypto15ml_imputations.json`)
- [ ] Environment variables configured
- [ ] Polymarket wallet funded with USDC.e
- [ ] CTF contracts approved (use OnchainService.approveAll())

### Start Sequence

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { Crypto15MLStrategyService } from '@catalyst-team/poly-sdk';
import { crypto15mlConfig } from './config/crypto15ml.config';

async function main() {
  // 1. Initialize SDK with wallet
  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  // 2. Verify prerequisites
  const status = await sdk.onchain.checkReadyForCTF('100');
  if (!status.ready) {
    console.error('Not ready for trading:', status.issues);
    await sdk.onchain.approveAll();
  }

  // 3. Create and configure strategy
  const strategy = new Crypto15MLStrategyService(
    sdk.markets,
    sdk.tradingService,
    sdk.realtime,
    crypto15mlConfig
  );

  // 4. Attach event handlers
  attachEventHandlers(strategy);

  // 5. Start strategy (requires connected WebSocket)
  await strategy.start();

  console.log('Strategy started');
  console.log(`Dry run: ${crypto15mlConfig.dryRun}`);
  console.log(`Tracking: ${strategy.getTrackerCount()} markets`);

  // 6. Handle shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    strategy.stop();
    sdk.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

### Stopping the Strategy

```typescript
// Graceful shutdown
strategy.stop();
sdk.stop();

// The stop() method:
// - Unsubscribes from WebSocket feeds
// - Clears all market trackers
// - Logs paper trading stats (if in dry-run mode)
```

## Monitoring

### Event Logging

All events are logged as structured JSON for Railway:

```json
{
  "timestamp": "2026-01-10T14:23:45.123Z",
  "level": "INFO",
  "strategy": "Crypto15ML",
  "event": "signal_generated",
  "marketId": "0xabc123",
  "symbol": "BTCUSDT",
  "side": "YES",
  "confidence": 0.73,
  "entryPrice": 0.52,
  "_service": "hermes",
  "_app": "trading",
  "_env": "production"
}
```

### Railway Log Filtering

Use Railway's log search to filter events:

```bash
# Signal events only
event:signal_generated

# Specific symbol
symbol:BTCUSDT

# Errors only
level:ERROR

# Failed executions
event:execution_failed

# Paper trading
event:paper_position OR event:paper_settlement

# By strategy
strategy:Crypto15ML

# Combined filters
level:INFO symbol:ETHUSDT event:signal_generated
```

### Key Events to Monitor

| Event | Level | Description |
|-------|-------|-------------|
| `strategy_started` | INFO | Strategy successfully started |
| `strategy_stopped` | INFO | Strategy stopped (includes stats) |
| `models_loaded` | INFO | ML models loaded successfully |
| `market_added` | INFO | New market being tracked |
| `market_removed` | INFO | Market expired or removed |
| `signal_generated` | INFO | Trading signal generated |
| `signal_rejected` | WARN | Signal rejected (price too high) |
| `execution_success` | INFO | Trade executed successfully |
| `execution_failed` | ERROR | Trade execution failed |
| `paper_position` | INFO | Paper position recorded (dry-run) |
| `paper_settlement` | INFO | Paper position settled (dry-run) |
| `error` | ERROR | General error occurred |

### Health Checks

```typescript
// Check if strategy is running
if (strategy.isRunning()) {
  console.log('Strategy is active');
}

// Get tracker count
const trackerCount = strategy.getTrackerCount();
console.log(`Tracking ${trackerCount} markets`);

// Get tracker details
const trackers = strategy.getTrackers();
for (const tracker of trackers) {
  console.log(`${tracker.slug}: traded=${tracker.traded}`);
}

// Paper trading stats (dry-run mode)
const stats = strategy.getPaperTradingStats();
console.log(`Positions: ${stats.positionCount}`);
console.log(`P&L: $${stats.cumulativePnL.toFixed(2)}`);
```

## When to Pause/Restart

### Pause When

- **High volatility events** - Major news, market crashes
- **Model degradation** - Win rate drops significantly
- **API issues** - Rate limiting, WebSocket disconnections
- **Insufficient funds** - USDC.e balance too low

### Restart When

- **Model update** - New model version deployed
- **Config changes** - Threshold adjustments
- **After pause** - Conditions returned to normal

### Pause Procedure

```typescript
// 1. Stop the strategy (keeps SDK connected)
strategy.stop();

// 2. Log pause reason
console.log('Strategy paused: high volatility');

// 3. Optionally get final stats
if (crypto15mlConfig.dryRun) {
  const stats = strategy.getPaperTradingStats();
  console.log('Final stats:', stats);
}
```

### Resume Procedure

```typescript
// 1. Update config if needed
crypto15mlConfig.yesThreshold = 0.75; // More conservative

// 2. Restart strategy
await strategy.start();

console.log('Strategy resumed');
```

## Model Retraining

When to retrain:

1. **Performance degradation** - Win rate < 55% over 100+ trades
2. **Market regime change** - Volatility patterns shift
3. **New data available** - Monthly/quarterly updates

See [MODEL_EXPORT.md](./MODEL_EXPORT.md) for export process.

### Deploying New Model

```bash
# 1. Export new model from Argus
python export_model.py --output ./models/

# 2. Validate model files
ls -la models/
# crypto15ml_model.json
# crypto15ml_imputations.json

# 3. Restart strategy to load new model
# (Strategy loads models on start())
```

## Troubleshooting

### Strategy Not Starting

**Symptom:** `start()` throws error

**Checks:**
1. Is RealtimeService connected?
   ```typescript
   if (!sdk.realtime.isConnected()) {
     await sdk.realtime.connect();
   }
   ```

2. Do model files exist?
   ```bash
   ls models/crypto15ml_model.json models/crypto15ml_imputations.json
   ```

3. Is config valid?
   ```typescript
   import { validateCrypto15MLConfig } from './config/crypto15ml.config';
   const issues = validateCrypto15MLConfig(crypto15mlConfig);
   if (issues.length > 0) {
     console.error('Config issues:', issues);
   }
   ```

### No Signals Generated

**Symptom:** Strategy running but no signals

**Checks:**
1. Current minute in `stateMinutes`?
   ```javascript
   const minute = new Date().getMinutes() % 15;
   console.log(`Current state minute: ${minute}`);
   // Signals only fire in minutes [0, 1, 2] by default
   ```

2. Markets being tracked?
   ```typescript
   console.log(`Trackers: ${strategy.getTrackerCount()}`);
   ```

3. Price feeds active?
   ```typescript
   // Check WebSocket connection
   console.log(`WS connected: ${sdk.realtime.isConnected()}`);
   ```

4. Thresholds too strict?
   ```typescript
   // Try more aggressive thresholds temporarily
   crypto15mlConfig.yesThreshold = 0.60;
   crypto15mlConfig.noThreshold = 0.40;
   ```

### Order Execution Failures

**Symptom:** `execution_failed` events in logs

**Common causes:**

1. **Insufficient balance**
   ```typescript
   const balances = await sdk.onchain.getBalances();
   console.log(`USDC.e: ${balances.usdcE}`);
   ```

2. **CTF not approved**
   ```typescript
   const status = await sdk.onchain.checkReadyForCTF('100');
   if (!status.ready) {
     await sdk.onchain.approveAll();
   }
   ```

3. **Rate limiting**
   - Check error message for "rate limit" or "429"
   - Reduce position frequency

4. **Market closed**
   - Check if market is still active
   - Verify end time hasn't passed

### WebSocket Disconnections

**Symptom:** Price updates stop, errors in logs

**Solutions:**
1. Enable auto-reconnect (default behavior)
2. Check network connectivity
3. Verify Polymarket WebSocket endpoint is up

```typescript
sdk.realtime.on('disconnect', () => {
  console.warn('WebSocket disconnected, will auto-reconnect');
});

sdk.realtime.on('reconnect', () => {
  console.log('WebSocket reconnected');
});
```

## Metrics to Track

### Short-term (Daily)

- Signals generated per hour
- Execution success rate
- Average entry price vs threshold
- WebSocket uptime

### Medium-term (Weekly)

- Win rate by asset
- Average P&L per trade
- Signal accuracy by state minute
- Position sizing effectiveness

### Long-term (Monthly)

- Cumulative P&L
- Model accuracy degradation
- Market regime changes
- Optimal threshold adjustments

## Alerts Setup

Recommended alerts for production:

```bash
# Strategy stopped unexpectedly
level:INFO event:strategy_stopped (not during deployment)

# High error rate
level:ERROR count > 10 in 5 minutes

# No signals in extended period
event:signal_generated count < 1 in 2 hours (during trading hours)

# Execution failures
event:execution_failed count > 3 in 30 minutes
```
