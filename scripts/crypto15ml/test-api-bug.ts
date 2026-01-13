/**
 * Test to verify Gamma API returns correct markets for condition IDs
 */

import { PolymarketSDK } from '../../src/index.js';

async function main() {
  const sdk = new PolymarketSDK({});

  // These are the condition IDs that the scanner found
  const testCases = [
    { conditionId: '0xdd60234a3c7418fb4287d90a6e5457f5bee1cb639a48df03a7b778f16bf73a39', expectedSlug: 'btc-updown-15m-1768217400' },
    { conditionId: '0x11f2c01fb70ea71ada8a65447a1ca9810f101d91869fd5f19ebeebff4837f46a', expectedSlug: 'eth-updown-15m-1768217400' },
  ];

  console.log('Testing Gamma API market lookups by conditionId...\n');

  for (const { conditionId, expectedSlug } of testCases) {
    console.log(`\n=== Testing ${expectedSlug} ===`);
    console.log(`ConditionId: ${conditionId}`);

    try {
      // Test 1: Try Gamma API directly
      console.log('\n1. Gamma API lookup by conditionId:');
      const gammaMarket = await sdk.gammaApi.getMarketByConditionId(conditionId);
      console.log(`   Found: ${gammaMarket?.slug || 'null'}`);
      console.log(`   Match: ${gammaMarket?.slug === expectedSlug ? '✅' : '❌'}`);
      if (gammaMarket && gammaMarket.slug !== expectedSlug) {
        console.log(`   ERROR: Expected "${expectedSlug}" but got "${gammaMarket.slug}"`);
      }

      // Test 2: Try scanning for the market by slug
      console.log('\n2. Gamma API lookup by slug:');
      const marketsBySlug = await sdk.gammaApi.getMarkets({ slug: expectedSlug, limit: 1 });
      if (marketsBySlug.length > 0) {
        console.log(`   Found: ${marketsBySlug[0].slug}`);
        console.log(`   ConditionId: ${marketsBySlug[0].conditionId}`);
        console.log(`   Match: ${marketsBySlug[0].conditionId === conditionId ? '✅' : '❌'}`);
        if (marketsBySlug[0].conditionId !== conditionId) {
          console.log(`   ERROR: Slug "${expectedSlug}" has different conditionId: ${marketsBySlug[0].conditionId}`);
        }
      } else {
        console.log(`   Not found ❌`);
      }

      // Test 3: Try the unified MarketService
      console.log('\n3. MarketService.getMarket(conditionId):');
      const unifiedMarket = await sdk.markets.getMarket(conditionId);
      console.log(`   Found: ${unifiedMarket.slug}`);
      console.log(`   Match: ${unifiedMarket.slug === expectedSlug ? '✅' : '❌'}`);

    } catch (error) {
      console.error('   Error:', error instanceof Error ? error.message : String(error));
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
