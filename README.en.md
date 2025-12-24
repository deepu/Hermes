# @catalyst-team/poly-sdk

Unified TypeScript SDK for Polymarket - prediction markets trading, arbitrage detection, smart money analysis, and comprehensive market data.

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-43%2F43%20passing-brightgreen.svg)](#testing)
[![License](https://img.shields.io/badge/license-Private-red.svg)](LICENSE)

**Builder**: [@hhhx402](https://x.com/hhhx402)
**Project**: [Catalyst.fun](https://x.com/catalystdotfun)

## Features

- 🔄 **Real-time Arbitrage Detection**: WebSocket monitoring with automatic execution
- 📊 **Smart Money Analysis**: Track top traders and their strategies
- 💱 **Trading Integration**: Place orders with GTC/GTD/FOK/FAK support
- 🔐 **On-Chain Operations**: Split, merge, and redeem CTF tokens
- 🌉 **Cross-Chain Bridge**: Deposit from Ethereum, Solana, Bitcoin
- 💰 **DEX Swaps**: Convert tokens on Polygon using QuickSwap V3
- 📈 **Market Analytics**: K-lines, signals, and volume analysis
- ✅ **Comprehensive Testing**: 100% test coverage (43/43 tests passing)

## Installation

```bash
pnpm add @catalyst-team/poly-sdk
```

## Quick Start

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

const sdk = new PolymarketSDK();

// Get market by slug or condition ID
const market = await sdk.getMarket('will-trump-win-2024');
console.log(market.tokens.yes.price); // 0.65

// Get processed orderbook with analytics
const orderbook = await sdk.getOrderbook(market.conditionId);
console.log(orderbook.summary.longArbProfit); // Arbitrage opportunity

// Detect arbitrage
const arb = await sdk.detectArbitrage(market.conditionId);
if (arb) {
  console.log(`${arb.type} arb: ${arb.profit * 100}% profit`);
}
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                             PolymarketSDK                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 3: Services                                                            │
│  ┌─────────────┐ ┌─────────────┐ ┌───────────────┐ ┌─────────────────────────┐│
│  │WalletService│ │MarketService│ │RealtimeService│ │   AuthorizationService  ││
│  │ - profiles  │ │ - K-Lines   │ │- subscriptions│ │   - ERC20 approvals     ││
│  │ - sell det. │ │ - signals   │ │- price cache  │ │   - ERC1155 approvals   ││
│  └─────────────┘ └─────────────┘ └───────────────┘ └─────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ ArbitrageService: Real-time arbitrage detection, rebalancer, settlement │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ SwapService: DEX swaps on Polygon (QuickSwap V3, USDC/USDC.e conversion)│  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 2: API Clients                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌────────────────────┐  │
│  │ DataAPI  │ │ GammaAPI │ │ CLOB API │ │ WebSocket │ │   BridgeClient     │  │
│  │positions │ │ markets  │ │ orderbook│ │ real-time │ │   cross-chain      │  │
│  │ trades   │ │ events   │ │ trading  │ │ prices    │ │   deposits         │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘ └────────────────────┘  │
│  ┌──────────────────────────────────────┐ ┌────────────────────────────────┐  │
│  │ TradingClient: Order execution       │ │ CTFClient: On-chain operations │  │
│  │ GTC/GTD/FOK/FAK, rewards, balances   │ │ Split / Merge / Redeem tokens  │  │
│  └──────────────────────────────────────┘ └────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 1: Infrastructure                                                      │
│  ┌────────────┐  ┌─────────┐  ┌──────────┐  ┌────────────┐ ┌──────────────┐   │
│  │RateLimiter │  │  Cache  │  │  Errors  │  │   Types    │ │ Price Utils  │   │
│  │per-API     │  │TTL-based│  │ retry    │  │ unified    │ │ arb detect   │   │
│  └────────────┘  └─────────┘  └──────────┘  └────────────┘ └──────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Understanding Polymarket's Mirror Orderbook

⚠️ **CRITICAL: Polymarket's orderbook has a mirror property that's easy to overlook:**

```
Buy YES @ P = Sell NO @ (1-P)
```

This means **the same order appears in both orderbooks**. For example, a "Sell NO @ 0.50" order will simultaneously appear as "Buy YES @ 0.50" in the YES orderbook.

**Common Mistake:**
```typescript
// ❌ WRONG: Simple addition double-counts mirror orders
const askSum = YES.ask + NO.ask;  // ≈ 1.998-1.999, not ≈ 1.0
const bidSum = YES.bid + NO.bid;  // ≈ 0.001-0.002, not ≈ 1.0
```

**Correct Approach: Use Effective Prices**
```typescript
import { getEffectivePrices, checkArbitrage } from '@catalyst-team/poly-sdk';

// Calculate optimal prices considering mirrors
const effective = getEffectivePrices(yesAsk, yesBid, noAsk, noBid);

// effective.effectiveBuyYes = min(YES.ask, 1 - NO.bid)
// effective.effectiveBuyNo = min(NO.ask, 1 - YES.bid)
// effective.effectiveSellYes = max(YES.bid, 1 - NO.ask)
// effective.effectiveSellNo = max(NO.bid, 1 - YES.ask)

// Detect arbitrage using effective prices
const arb = checkArbitrage(yesAsk, noAsk, yesBid, noBid);
if (arb) {
  console.log(`${arb.type} arb: ${(arb.profit * 100).toFixed(2)}% profit`);
  console.log(arb.description);
}
```

See detailed documentation: [docs/01-polymarket-orderbook-arbitrage.md](docs/01-polymarket-orderbook-arbitrage.md)

### ArbitrageService - Automated Trading

Real-time arbitrage detection and execution with market scanning, auto-rebalancing, and smart position clearing.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Core Features                                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  • scanMarkets()     - Scan markets for arbitrage opportunities              │
│  • start(market)     - Start real-time monitoring + auto-execution           │
│  • clearPositions()  - Smart clearing (sell active, redeem resolved)         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Auto-Rebalancer                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Arbitrage requires USDC + YES/NO tokens. Rebalancer maintains optimal mix:  │
│  • USDC < 20%  → Auto Merge (YES+NO → USDC)                                 │
│  • USDC > 80%  → Auto Split (USDC → YES+NO)                                 │
│  • Cooldown: 30s between actions, 10s check interval                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Partial Fill Protection                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Arbitrage needs both YES and NO, but orders may partially fill:             │
│  • sizeSafetyFactor=0.8 → Use only 80% of orderbook depth                   │
│  • autoFixImbalance=true → Auto-sell excess if one side fails                │
│  • imbalanceThreshold=5 → Trigger fix when YES-NO diff > $5                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Complete Workflow:**

```typescript
import { ArbitrageService } from '@catalyst-team/poly-sdk';

const arbService = new ArbitrageService({
  privateKey: process.env.POLY_PRIVKEY,
  profitThreshold: 0.005,  // 0.5% minimum profit
  minTradeSize: 5,         // $5 minimum
  maxTradeSize: 100,       // $100 maximum
  autoExecute: true,       // Auto-execute opportunities

  // Rebalancer config
  enableRebalancer: true,  // Auto-rebalance position
  minUsdcRatio: 0.2,       // Min 20% USDC (Split if below)
  maxUsdcRatio: 0.8,       // Max 80% USDC (Merge if above)
  targetUsdcRatio: 0.5,    // Target 50% when rebalancing
  imbalanceThreshold: 5,   // Max YES-NO difference before fix
  rebalanceInterval: 10000, // Check every 10s
  rebalanceCooldown: 30000, // Min 30s between actions

  // Execution safety (prevents YES ≠ NO from partial fills)
  sizeSafetyFactor: 0.8,   // Use 80% of orderbook depth
  autoFixImbalance: true,  // Auto-sell excess if one side fails
});

// Listen for events
arbService.on('opportunity', (opp) => {
  console.log(`${opp.type.toUpperCase()} ARB: ${opp.profitPercent.toFixed(2)}%`);
});

arbService.on('execution', (result) => {
  if (result.success) {
    console.log(`✅ Executed: $${result.profit.toFixed(2)} profit`);
  }
});

// ========== Step 1: Scan Markets ==========
const results = await arbService.scanMarkets({ minVolume24h: 5000 }, 0.005);
console.log(`Found ${results.filter(r => r.arbType !== 'none').length} opportunities`);

// Or use one-click scan + start best market
const best = await arbService.findAndStart(0.005);
if (!best) {
  console.log('No arbitrage opportunities found');
  process.exit(0);
}
console.log(`🎯 Started: ${best.market.name} (+${best.profitPercent.toFixed(2)}%)`);

// ========== Step 2: Run Arbitrage ==========
// Service now auto-monitors and executes...
await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000)); // 1 hour

// ========== Step 3: Stop & Clear Positions ==========
await arbService.stop();
console.log('Stats:', arbService.getStats());

// Smart clearing: merge+sell active markets, redeem resolved markets
const clearResult = await arbService.clearPositions(best.market, true);
console.log(`✅ Recovered: $${clearResult.totalUsdcRecovered.toFixed(2)}`);
```

## Testing

This package includes comprehensive testing infrastructure with **100% test coverage**:

```bash
# Run all tests
pnpm test:unit        # 27 unit tests
pnpm test:integration # 10 integration tests
pnpm test:e2e         # 6 E2E tests (requires funded wallet)
```

### Test Coverage

| Test Level | Tests | Coverage | Description |
|------------|-------|----------|-------------|
| **Unit Tests** | 27/27 ✅ | Mirror orderbook calculations, arbitrage detection |
| **Integration Tests** | 10/10 ✅ | WebSocket real-time monitoring, market scanning |
| **E2E Tests** | 6/6 ✅ | On-chain CTF operations on Polygon mainnet |

All tests are located in `scripts/arb-tests/`:
- `01-unit-tests.ts` - Price utilities and arbitrage logic
- `02-integration-tests.ts` - API integration and WebSocket
- `03-e2e-tests.ts` - Real blockchain transactions (Split/Merge)

See [docs/arb/test-results.md](docs/arb/test-results.md) for detailed test reports.

## API Clients

### TradingClient - Order Execution

```typescript
import { TradingClient, RateLimiter } from '@catalyst-team/poly-sdk';

const tradingClient = new TradingClient(new RateLimiter(), {
  privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
});

await tradingClient.initialize();

// GTC Limit Order (stays until filled or cancelled)
const order = await tradingClient.createOrder({
  tokenId: yesTokenId,
  side: 'BUY',
  price: 0.45,
  size: 10,
  orderType: 'GTC',
});

// FOK Market Order (fill entirely or cancel)
const marketOrder = await tradingClient.createMarketOrder({
  tokenId: yesTokenId,
  side: 'BUY',
  amount: 10, // $10 USDC
  orderType: 'FOK',
});

// Order management
const openOrders = await tradingClient.getOpenOrders();
await tradingClient.cancelOrder(orderId);
```

### CTFClient - On-Chain Token Operations

The CTF (Conditional Token Framework) client enables on-chain operations for Polymarket's conditional tokens.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CTF Operations Quick Reference                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Operation   │ Function                │ Typical Use Case                    │
├──────────────┼─────────────────────────┼─────────────────────────────────────┤
│  Split       │ USDC → YES + NO         │ Market making: create token inventory│
│  Merge       │ YES + NO → USDC         │ Arbitrage: buy both and merge       │
│  Redeem      │ Winning token → USDC    │ Settlement: claim winnings          │
└─────────────────────────────────────────────────────────────────────────────┘
```

```typescript
import { CTFClient } from '@catalyst-team/poly-sdk';

const ctf = new CTFClient({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
  rpcUrl: 'https://polygon-rpc.com',
});

// Split: USDC → YES + NO tokens
const splitResult = await ctf.split(conditionId, '100');
console.log(`Created ${splitResult.yesTokens} YES + ${splitResult.noTokens} NO`);

// Merge: YES + NO → USDC
const tokenIds = {
  yesTokenId: market.tokens[0].tokenId,
  noTokenId: market.tokens[1].tokenId,
};
const mergeResult = await ctf.mergeByTokenIds(conditionId, tokenIds, '100');
console.log(`Received ${mergeResult.usdcReceived} USDC`);

// Redeem: Winning tokens → USDC
const redeemResult = await ctf.redeemByTokenIds(conditionId, tokenIds);
console.log(`Redeemed ${redeemResult.tokensRedeemed} tokens`);
```

⚠️ **Important: Use `mergeByTokenIds()` and `redeemByTokenIds()` for Polymarket markets**

Polymarket uses custom token IDs that differ from standard CTF position IDs. Always use the `*ByTokenIds` methods with token IDs from CLOB API.

### SwapService - DEX Swaps on Polygon

Swap tokens on Polygon using QuickSwap V3. Essential for converting to USDC.e for CTF operations.

⚠️ **USDC vs USDC.e for Polymarket CTF**

| Token | Address | Polymarket CTF |
|-------|---------|----------------|
| USDC.e | `0x2791...` | ✅ **Required** |
| USDC (Native) | `0x3c49...` | ❌ Not accepted |

```typescript
import { SwapService, POLYGON_TOKENS } from '@catalyst-team/poly-sdk';

const swapService = new SwapService(signer);

// Swap native USDC to USDC.e for CTF operations
const swapResult = await swapService.swap('USDC', 'USDC_E', '100');
console.log(`Swapped: ${swapResult.amountOut} USDC.e`);

// Swap MATIC to USDC.e
const maticSwap = await swapService.swap('MATIC', 'USDC_E', '50');

// Get quote before swapping
const quote = await swapService.getQuote('WETH', 'USDC_E', '0.1');
console.log(`Expected output: ${quote.estimatedAmountOut} USDC.e`);
```

### WalletService - Smart Money Analysis

```typescript
// Get top traders
const traders = await sdk.wallets.getTopTraders(10);

// Get wallet profile with smart score
const profile = await sdk.wallets.getWalletProfile('0x...');
console.log(profile.smartScore); // 0-100

// Detect sell activity (for follow-wallet strategy)
const sellResult = await sdk.wallets.detectSellActivity(
  '0x...',
  conditionId,
  Date.now() - 24 * 60 * 60 * 1000
);
if (sellResult.isSelling) {
  console.log(`Sold ${sellResult.percentageSold}%`);
}
```

### MarketService - K-Lines and Signals

```typescript
// Get K-Line candles
const klines = await sdk.markets.getKLines(conditionId, '1h', { limit: 100 });

// Get dual K-Lines (YES + NO) with spread analysis
const dual = await sdk.markets.getDualKLines(conditionId, '1h');

// Historical spread (from trade close prices) - for backtesting
for (const point of dual.spreadAnalysis) {
  console.log(`${point.timestamp}: sum=${point.priceSum}, spread=${point.priceSpread}`);
  if (point.arbOpportunity) {
    console.log(`  Historical ${point.arbOpportunity} signal`);
  }
}

// Real-time spread (from orderbook) - for live trading
if (dual.realtimeSpread) {
  const rt = dual.realtimeSpread;
  if (rt.arbOpportunity) {
    console.log(`🎯 ${rt.arbOpportunity} ARB: ${rt.arbProfitPercent.toFixed(2)}%`);
  }
}
```

#### Spread Analysis - Two Approaches

```
┌─────────────────────────────────────────────────────────────────────────┐
│  spreadAnalysis (Historical)      │  realtimeSpread (Live Trading)      │
├─────────────────────────────────────────────────────────────────────────┤
│  Data Source: Trade close prices  │  Data Source: Orderbook bid/ask     │
│  YES_close + NO_close             │  Uses effective prices (mirrors)    │
├─────────────────────────────────────────────────────────────────────────┤
│  ✅ Can build historical chart    │  ❌ No historical data available*   │
│  ✅ Polymarket keeps trade history│  ❌ Polymarket doesn't keep snapshots│
│  ✅ Good for backtesting           │  ✅ Good for live trading           │
│  ⚠️ Arb signals are approximate    │  ✅ Arb profit calculation accurate │
└─────────────────────────────────────────────────────────────────────────┘

* To build historical real-time spread, you must store orderbook snapshots yourself
  See: apps/api/src/services/spread-sampler.ts
```

### RealtimeService - WebSocket Subscriptions

⚠️ **Important: Orderbook Auto-Sorting**

Polymarket CLOB API returns orderbooks in reverse order from standard expectations:
- **bids**: Ascending (lowest first = worst price)
- **asks**: Descending (highest first = worst price)

Our SDK **automatically normalizes** orderbook data:
- **bids**: Descending (highest first = best bid)
- **asks**: Ascending (lowest first = best ask)

This means you can safely use `bids[0]` and `asks[0]` to get best prices:

```typescript
const book = await sdk.clobApi.getOrderbook(conditionId);
const bestBid = book.bids[0]?.price;  // ✅ Highest bid (best)
const bestAsk = book.asks[0]?.price;  // ✅ Lowest ask (best)

// WebSocket updates are also auto-sorted
wsManager.on('bookUpdate', (update) => {
  const bestBid = update.bids[0]?.price;  // ✅ Already sorted
  const bestAsk = update.asks[0]?.price;  // ✅ Already sorted
});
```

## Examples

| Example | Description | Command |
|---------|-------------|---------|
| [Basic Usage](examples/01-basic-usage.ts) | Get markets, orderbooks, detect arbitrage | `pnpm example:basic` |
| [Smart Money](examples/02-smart-money.ts) | Top traders, wallet profiles, smart scores | `pnpm example:smart-money` |
| [Market Analysis](examples/03-market-analysis.ts) | Market signals, volume analysis | `pnpm example:market-analysis` |
| [K-Line Aggregation](examples/04-kline-aggregation.ts) | Build OHLCV candles from trades | `pnpm example:kline` |
| [Follow Wallet](examples/05-follow-wallet-strategy.ts) | Track smart money positions, detect exits | `pnpm example:follow-wallet` |
| [Services Demo](examples/06-services-demo.ts) | All SDK services in action | `pnpm example:services` |
| [Realtime WebSocket](examples/07-realtime-websocket.ts) | Live price feeds, orderbook updates | `pnpm example:realtime` |
| [Trading Orders](examples/08-trading-orders.ts) | GTC, GTD, FOK, FAK order types | `pnpm example:trading` |
| [Rewards Tracking](examples/09-rewards-tracking.ts) | Market maker incentives, earnings | `pnpm example:rewards` |
| [CTF Operations](examples/10-ctf-operations.ts) | Split, merge, redeem tokens | `pnpm example:ctf` |
| [Live Arbitrage Scan](examples/11-live-arbitrage-scan.ts) | Scan real markets for opportunities | `pnpm example:live-arb` |

## Error Handling

```typescript
import { PolymarketError, ErrorCode, withRetry } from '@catalyst-team/poly-sdk';

try {
  const market = await sdk.getMarket('invalid-slug');
} catch (error) {
  if (error instanceof PolymarketError) {
    if (error.code === ErrorCode.MARKET_NOT_FOUND) {
      console.log('Market not found');
    } else if (error.code === ErrorCode.RATE_LIMITED) {
      console.log('Rate limited, retry later');
    }
  }
}

// Auto-retry with exponential backoff
const result = await withRetry(() => sdk.getMarket(slug), {
  maxRetries: 3,
  baseDelay: 1000,
});
```

## Rate Limiting

Built-in rate limiting per API type:
- Data API: 10 req/sec
- Gamma API: 10 req/sec
- CLOB API: 5 req/sec

```typescript
import { RateLimiter, ApiType } from '@catalyst-team/poly-sdk';

// Custom rate limiter
const limiter = new RateLimiter({
  [ApiType.DATA]: { maxConcurrent: 5, minTime: 200 },
  [ApiType.GAMMA]: { maxConcurrent: 5, minTime: 200 },
  [ApiType.CLOB]: { maxConcurrent: 2, minTime: 500 },
});
```

## Documentation

- [Orderbook & Arbitrage Guide](docs/01-polymarket-orderbook-arbitrage.md) - Understanding mirror orders
- [Test Plan](docs/arb/test-plan.md) - Testing strategy and approach
- [Test Results](docs/arb/test-results.md) - Detailed test coverage report
- [Test Scripts README](scripts/arb-tests/README.md) - Running tests

## Dependencies

- `@nevuamarkets/poly-websockets` - WebSocket client
- `bottleneck` - Rate limiting
- `ethers` - Blockchain interactions

## License

Private

## Changelog

### v0.2.0 (2024-12-24)

- ✅ **Complete test coverage**: 43/43 tests passing (100%)
  - 27 unit tests for arbitrage detection logic
  - 10 integration tests for WebSocket and market scanning
  - 6 E2E tests with real on-chain transactions
- 🐛 Fixed WebSocket integration tests (listen to `orderbookUpdate` events)
- 📊 Smart market selection based on volume and orderbook depth
- 📝 Comprehensive test documentation and reports
- 🔧 Test infrastructure for ArbitrageService verification

### v0.1.1

- Initial arbitrage service implementation
- CTF operations support
- Real-time WebSocket monitoring
