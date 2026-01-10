# Crypto15ML Railway Deployment Guide

Complete guide to deploying the Crypto15ML strategy on Railway.

## Prerequisites

Before deploying:

1. **Model files in place**
   - `models/crypto15ml_model.json` - Trained model coefficients
   - `models/crypto15ml_imputations.json` - Feature imputation values

2. **Railway account**
   - Sign up at [railway.app](https://railway.app)
   - Install Railway CLI: `npm install -g @railway/cli`

3. **Polymarket wallet**
   - Funded with USDC.e on Polygon
   - Private key available for configuration

## Model Export from Argus

Export trained models from the Argus research pipeline:

```bash
# Navigate to Argus repository
cd ~/dev/argus

# Run the export script
python research/crypto_15minute/scripts/run_intrawindow_state_strategy.py \
  --label-column y_15m \
  --model-output models/crypto15ml_model.json \
  --imputation-output models/crypto15ml_imputations.json

# Copy to Hermes
cp models/crypto15ml_model.json ~/dev/Hermes/models/
cp models/crypto15ml_imputations.json ~/dev/Hermes/models/
```

**Note:** If the export script fails, check if pre-existing models exist:
```bash
ls ~/dev/argus/research/crypto_15minute/results/
# Use intrawindow_state_strategy_model.json and intrawindow_state_strategy_imputations.json
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `POLYMARKET_PRIVATE_KEY` | Wallet private key | `0x...` (64 hex chars) |

### Strategy Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CRYPTO15ML_ENABLED` | `true` | Enable/disable the strategy |
| `CRYPTO15ML_DRY_RUN` | `true` | Paper trading mode (no real trades) |
| `CRYPTO15ML_POSITION_SIZE` | `100` | Position size per trade in USD |
| `CRYPTO15ML_YES_THRESHOLD` | `0.70` | Minimum probability for YES signal |
| `CRYPTO15ML_NO_THRESHOLD` | `0.30` | Maximum probability for NO signal |
| `CRYPTO15ML_ENTRY_PRICE_CAP` | `0.70` | Maximum acceptable entry price |
| `CRYPTO15ML_DEBUG` | `false` | Enable verbose logging |
| `CRYPTO15ML_SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT` | Comma-separated list of symbols |
| `CRYPTO15ML_HORIZON_MINUTES` | `15` | Prediction horizon in minutes |

### Threshold Configuration (Advanced)

| Variable | Default | Description |
|----------|---------|-------------|
| `CRYPTO15ML_THRESHOLD_BTC` | `0.0008` | BTC threshold (8 bps) |
| `CRYPTO15ML_THRESHOLD_ETH` | `0.0010` | ETH threshold (10 bps) |
| `CRYPTO15ML_THRESHOLD_SOL` | `0.0020` | SOL threshold (20 bps) |
| `CRYPTO15ML_THRESHOLD_XRP` | `0.0015` | XRP threshold (15 bps) |

### Model Paths (usually not needed)

| Variable | Default | Description |
|----------|---------|-------------|
| `CRYPTO15ML_MODEL_PATH` | `./models/crypto15ml_model.json` | Path to model file |
| `CRYPTO15ML_IMPUTATION_PATH` | `./models/crypto15ml_imputations.json` | Path to imputation file |

## Deployment Phases

### Phase 1: Dry-Run Validation (24-48 hours)

Deploy in paper trading mode first:

```bash
# Set environment variables in Railway
railway variables set POLYMARKET_PRIVATE_KEY="your_key_here"
railway variables set CRYPTO15ML_ENABLED=true
railway variables set CRYPTO15ML_DRY_RUN=true
railway variables set CRYPTO15ML_POSITION_SIZE=100

# Deploy
railway up
```

**Monitor during dry-run:**
- Signal generation rate (~250 signals/day expected)
- Paper P&L tracking
- Error rates in logs

### Phase 2: Small Live Trading (24 hours)

After validating dry-run results:

```bash
# Switch to live mode with small position size
railway variables set CRYPTO15ML_DRY_RUN=false
railway variables set CRYPTO15ML_POSITION_SIZE=10

# Redeploy
railway up
```

**Monitor during small live:**
- Real execution success rate
- Actual P&L vs paper P&L
- Gas costs and slippage

### Phase 3: Scaled Live Trading

After validating small live results:

```bash
# Increase position size
railway variables set CRYPTO15ML_POSITION_SIZE=100

# Redeploy
railway up
```

## Railway Dashboard Setup

### 1. Create New Project

```bash
railway login
railway init
```

### 2. Link GitHub Repository

In Railway dashboard:
1. Settings > Source
2. Connect GitHub repository
3. Select `main` branch
4. Enable automatic deployments

### 3. Configure Variables

In Railway dashboard:
1. Variables tab
2. Add all required environment variables
3. Use Railway's secret reference for `POLYMARKET_PRIVATE_KEY`

### 4. Deploy

```bash
railway up
```

Or push to GitHub for automatic deployment.

## Monitoring

### Log Search Queries

Railway supports log search. Useful queries:

```bash
# All signals
event:signal_generated

# Specific asset
symbol:BTCUSDT

# Errors only
level:ERROR

# Execution results
event:execution_result

# Paper trading (dry-run)
event:paper_position OR event:paper_settlement

# Strategy lifecycle
event:strategy_started OR event:strategy_stopped
```

### Key Metrics to Watch

| Metric | Expected | Alert If |
|--------|----------|----------|
| Signal rate | ~250/day | < 100/day |
| Win rate | 55-58% | < 50% |
| Execution success | > 95% | < 90% |
| Error rate | < 1% | > 5% |

### Health Checks

The strategy logs structured JSON that Railway can parse:

```json
{
  "timestamp": "2026-01-10T12:00:00.000Z",
  "level": "INFO",
  "event": "signal_generated",
  "asset": "BTCUSDT",
  "side": "YES",
  "probability": 0.73,
  "_service": "hermes",
  "_app": "crypto15ml"
}
```

## Kill Switch

To immediately stop trading:

### Option 1: Disable via Environment Variable

```bash
railway variables set CRYPTO15ML_ENABLED=false
railway up
```

### Option 2: Stop the Service

In Railway dashboard:
1. Settings > Service
2. Click "Stop Service"

### Option 3: Redeploy with Dry-Run

```bash
railway variables set CRYPTO15ML_DRY_RUN=true
railway up
```

## Troubleshooting

### Strategy Not Starting

**Check:**
1. Model files exist in `models/` directory
2. Environment variables are set correctly
3. Railway logs for startup errors

```bash
railway logs
```

### No Signals Generated

**Possible causes:**
1. Current time not in state minutes [0, 1, 2]
2. No active 15-minute crypto markets
3. WebSocket connection issues

**Check:**
```bash
railway logs --filter "event:strategy_started"
railway logs --filter "event:market_added"
```

### Execution Failures

**Common causes:**
1. Insufficient USDC.e balance
2. CTF contracts not approved
3. Rate limiting

**Check wallet status:**
- Verify balance on Polygonscan
- Check order error messages in logs

### WebSocket Disconnections

The strategy auto-reconnects, but if persistent:
1. Check Railway network status
2. Verify Polymarket WebSocket endpoint is up
3. Review error logs for specific disconnect reasons

## Cost Estimates

### Railway Costs

- **Starter:** Free tier with limits
- **Pro:** ~$5-20/month depending on usage

### Trading Costs

- **Position size:** $100/trade
- **Expected trades:** ~250/day
- **Gas costs:** ~$0.01-0.05 per trade on Polygon
- **Total daily gas:** ~$2.50-12.50

## Rollback Procedure

If issues occur:

1. **Stop current deployment**
   ```bash
   railway down
   ```

2. **Revert to previous version**
   - In Railway dashboard, go to Deployments
   - Click on previous successful deployment
   - Click "Redeploy"

3. **Or revert code and redeploy**
   ```bash
   git revert HEAD
   git push
   ```

## Security Notes

1. **Never commit private keys** - Use Railway's secret variables
2. **Model files are committed to the repository** - They contain proprietary coefficients but are small enough to be included
3. **Use Railway's encrypted variables** for sensitive data
4. **Limit wallet balance** to minimize exposure
