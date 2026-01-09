/**
 * Crypto15LRModel Unit Tests
 *
 * Tests for the logistic regression model including:
 * - Logistic regression computation (z = intercept + sum(coefficients * features))
 * - Sigmoid transformation with numerical stability
 * - NaN feature imputation
 * - Imputation count tracking
 * - Coefficient/feature length validation
 *
 * Part of #5
 */

import { describe, it, expect } from 'vitest';
import { Crypto15LRModel, type ModelConfig, type FeatureMap } from './crypto15-lr-model.js';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a minimal valid model config for testing.
 * All required fields are populated with sensible defaults.
 */
function createTestConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    version: '1.0.0',
    asset: 'BTC',
    featureColumns: ['feature1', 'feature2'],
    coefficients: [0.5, -0.3],
    intercept: 0.1,
    featureMedians: {
      feature1: 1.0,
      feature2: 2.0,
    },
    ...overrides,
  };
}

/**
 * Manually compute sigmoid for test verification
 */
function sigmoid(z: number): number {
  if (z > 20) return 1.0;
  if (z < -20) return 0.0;
  return 1 / (1 + Math.exp(-z));
}

// ============================================================================
// Constructor Validation Tests
// ============================================================================

describe('Crypto15LRModel', () => {
  describe('constructor validation', () => {
    it('should create model with valid config', () => {
      const config = createTestConfig();
      const model = new Crypto15LRModel(config);

      expect(model.getAsset()).toBe('BTC');
      expect(model.getVersion()).toBe('1.0.0');
    });

    it('should throw for null config', () => {
      expect(() => new Crypto15LRModel(null as unknown as ModelConfig)).toThrow(
        'Model config is required'
      );
    });

    it('should throw for undefined config', () => {
      expect(() => new Crypto15LRModel(undefined as unknown as ModelConfig)).toThrow(
        'Model config is required'
      );
    });

    it('should throw for empty version string', () => {
      const config = createTestConfig({ version: '' });
      expect(() => new Crypto15LRModel(config)).toThrow('non-empty version string');
    });

    it('should throw for empty asset string', () => {
      const config = createTestConfig({ asset: '' });
      expect(() => new Crypto15LRModel(config)).toThrow('non-empty asset string');
    });

    it('should throw for empty featureColumns array', () => {
      const config = createTestConfig({ featureColumns: [], coefficients: [] });
      expect(() => new Crypto15LRModel(config)).toThrow('non-empty featureColumns array');
    });

    it('should throw for empty coefficients array', () => {
      const config = createTestConfig({ coefficients: [] });
      expect(() => new Crypto15LRModel(config)).toThrow('non-empty coefficients array');
    });

    it('should throw for mismatched featureColumns and coefficients length', () => {
      const config = createTestConfig({
        featureColumns: ['feature1', 'feature2', 'feature3'],
        coefficients: [0.5, -0.3], // Only 2 coefficients for 3 features
      });
      expect(() => new Crypto15LRModel(config)).toThrow(
        'Feature columns length (3) must match coefficients length (2)'
      );
    });

    it('should throw for non-finite intercept (Infinity)', () => {
      const config = createTestConfig({ intercept: Infinity });
      expect(() => new Crypto15LRModel(config)).toThrow('intercept must be a finite number');
    });

    it('should throw for non-finite intercept (NaN)', () => {
      const config = createTestConfig({ intercept: NaN });
      expect(() => new Crypto15LRModel(config)).toThrow('intercept must be a finite number');
    });

    it('should throw for non-finite coefficient', () => {
      const config = createTestConfig({
        coefficients: [0.5, Infinity],
      });
      expect(() => new Crypto15LRModel(config)).toThrow(
        'coefficient at index 1 must be a finite number'
      );
    });

    it('should throw for NaN coefficient', () => {
      const config = createTestConfig({
        coefficients: [NaN, -0.3],
      });
      expect(() => new Crypto15LRModel(config)).toThrow(
        'coefficient at index 0 must be a finite number'
      );
    });

    it('should throw for empty feature column name', () => {
      const config = createTestConfig({
        featureColumns: ['feature1', ''],
      });
      expect(() => new Crypto15LRModel(config)).toThrow(
        'non-empty feature column at index 1'
      );
    });

    it('should throw for missing featureMedians object', () => {
      const config = createTestConfig({
        featureMedians: null as unknown as Record<string, number>,
      });
      expect(() => new Crypto15LRModel(config)).toThrow('featureMedians object');
    });

    it('should throw for non-finite feature median', () => {
      const config = createTestConfig({
        featureMedians: {
          feature1: 1.0,
          feature2: Infinity,
        },
      });
      expect(() => new Crypto15LRModel(config)).toThrow(
        "feature median for 'feature2' must be a finite number"
      );
    });

    it('should deep copy config to prevent external mutation', () => {
      const originalConfig = createTestConfig();
      const model = new Crypto15LRModel(originalConfig);

      // Mutate original config
      originalConfig.coefficients[0] = 999;
      originalConfig.featureColumns[0] = 'mutated';
      originalConfig.featureMedians.feature1 = 999;

      // Model should retain original values
      const modelConfig = model.getConfig();
      expect(modelConfig.coefficients[0]).toBe(0.5);
      expect(modelConfig.featureColumns[0]).toBe('feature1');
      expect(modelConfig.featureMedians.feature1).toBe(1.0);
    });
  });

  // ============================================================================
  // Prediction Tests - Basic Computation
  // ============================================================================

  describe('predict - basic computation', () => {
    it('should compute simple prediction with known coefficients', () => {
      // Example from issue description:
      // z = 0.1 + (0.5 * 2.0) + (-0.3 * 1.0) = 0.1 + 1.0 - 0.3 = 0.8
      // p = sigmoid(0.8) ≈ 0.6899
      const model = new Crypto15LRModel(createTestConfig());

      const result = model.predict({
        feature1: 2.0,
        feature2: 1.0,
      });

      expect(result.probability).toBeCloseTo(0.6899, 3);
      expect(result.imputedCount).toBe(0);
      expect(result.linearCombination).toBeCloseTo(0.8, 10);
    });

    it('should compute z = intercept when all features are zero', () => {
      const config = createTestConfig({ intercept: 0.5 });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        feature1: 0,
        feature2: 0,
      });

      // z = 0.5 + (0.5 * 0) + (-0.3 * 0) = 0.5
      expect(result.linearCombination).toBe(0.5);
      expect(result.probability).toBeCloseTo(sigmoid(0.5), 10);
    });

    it('should compute correct probability for z = 0 (should be 0.5)', () => {
      const config = createTestConfig({ intercept: 0, coefficients: [0, 0] });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        feature1: 10,
        feature2: 10,
      });

      expect(result.linearCombination).toBe(0);
      expect(result.probability).toBe(0.5);
    });

    it('should handle negative feature values', () => {
      const model = new Crypto15LRModel(createTestConfig());

      const result = model.predict({
        feature1: -2.0,
        feature2: -1.0,
      });

      // z = 0.1 + (0.5 * -2.0) + (-0.3 * -1.0) = 0.1 - 1.0 + 0.3 = -0.6
      expect(result.linearCombination).toBeCloseTo(-0.6, 10);
      expect(result.probability).toBeCloseTo(sigmoid(-0.6), 10);
    });

    it('should handle decimal feature values', () => {
      const model = new Crypto15LRModel(createTestConfig());

      const result = model.predict({
        feature1: 0.123,
        feature2: 0.456,
      });

      // z = 0.1 + (0.5 * 0.123) + (-0.3 * 0.456)
      const expectedZ = 0.1 + 0.5 * 0.123 + -0.3 * 0.456;
      expect(result.linearCombination).toBeCloseTo(expectedZ, 10);
    });

    it('should handle single-feature model', () => {
      const config = createTestConfig({
        featureColumns: ['single'],
        coefficients: [2.0],
        intercept: -1.0,
        featureMedians: { single: 0.5 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ single: 3.0 });

      // z = -1.0 + (2.0 * 3.0) = 5.0
      expect(result.linearCombination).toBe(5.0);
      expect(result.probability).toBeCloseTo(sigmoid(5.0), 10);
    });

    it('should handle many-feature model', () => {
      const featureColumns = ['f1', 'f2', 'f3', 'f4', 'f5'];
      const coefficients = [0.1, 0.2, 0.3, 0.4, 0.5];
      const featureMedians: Record<string, number> = {};
      const features: FeatureMap = {};

      for (let i = 0; i < featureColumns.length; i++) {
        featureMedians[featureColumns[i]] = i * 0.1;
        features[featureColumns[i]] = i + 1;
      }

      const config = createTestConfig({
        featureColumns,
        coefficients,
        intercept: 0,
        featureMedians,
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict(features);

      // z = 0 + (0.1*1) + (0.2*2) + (0.3*3) + (0.4*4) + (0.5*5)
      //   = 0.1 + 0.4 + 0.9 + 1.6 + 2.5 = 5.5
      expect(result.linearCombination).toBeCloseTo(5.5, 10);
    });
  });

  // ============================================================================
  // Prediction Tests - Sigmoid Numerical Stability
  // ============================================================================

  describe('predict - sigmoid numerical stability', () => {
    it('should return 1.0 for z > 20', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: 25 });

      expect(result.linearCombination).toBe(25);
      expect(result.probability).toBe(1.0);
    });

    it('should return 1.0 for z = 21 (just above threshold)', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: 21 });

      expect(result.linearCombination).toBe(21);
      expect(result.probability).toBe(1.0);
    });

    it('should return ~1.0 for z = 20 (at threshold, uses sigmoid)', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: 20 });

      expect(result.linearCombination).toBe(20);
      // At z=20, sigmoid is very close to 1 but uses the formula
      expect(result.probability).toBeCloseTo(1 / (1 + Math.exp(-20)), 10);
    });

    it('should return 0.0 for z < -20', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: -25 });

      expect(result.linearCombination).toBe(-25);
      expect(result.probability).toBe(0.0);
    });

    it('should return 0.0 for z = -21 (just below threshold)', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: -21 });

      expect(result.linearCombination).toBe(-21);
      expect(result.probability).toBe(0.0);
    });

    it('should return ~0.0 for z = -20 (at threshold, uses sigmoid)', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: -20 });

      expect(result.linearCombination).toBe(-20);
      // At z=-20, sigmoid is very close to 0 but uses the formula
      expect(result.probability).toBeCloseTo(1 / (1 + Math.exp(20)), 10);
    });

    it('should handle extremely large positive z without overflow', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: 1000000 });

      expect(result.linearCombination).toBe(1000000);
      expect(result.probability).toBe(1.0);
      expect(Number.isFinite(result.probability)).toBe(true);
    });

    it('should handle extremely large negative z without underflow', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1.0],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: -1000000 });

      expect(result.linearCombination).toBe(-1000000);
      expect(result.probability).toBe(0.0);
      expect(Number.isFinite(result.probability)).toBe(true);
    });
  });

  // ============================================================================
  // Prediction Tests - Imputation
  // ============================================================================

  describe('predict - NaN feature imputation', () => {
    it('should impute NaN feature with median value', () => {
      const config = createTestConfig({
        featureColumns: ['feature1', 'feature2'],
        coefficients: [1.0, 1.0],
        intercept: 0,
        featureMedians: { feature1: 5.0, feature2: 3.0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        feature1: NaN,
        feature2: 2.0,
      });

      // feature1 imputed with 5.0
      // z = 0 + (1.0 * 5.0) + (1.0 * 2.0) = 7.0
      expect(result.linearCombination).toBe(7.0);
      expect(result.imputedCount).toBe(1);
    });

    it('should impute multiple NaN features', () => {
      const config = createTestConfig({
        featureColumns: ['f1', 'f2', 'f3'],
        coefficients: [1.0, 1.0, 1.0],
        intercept: 0,
        featureMedians: { f1: 1.0, f2: 2.0, f3: 3.0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        f1: NaN,
        f2: NaN,
        f3: 10.0,
      });

      // f1 imputed with 1.0, f2 imputed with 2.0
      // z = 0 + (1.0 * 1.0) + (1.0 * 2.0) + (1.0 * 10.0) = 13.0
      expect(result.linearCombination).toBe(13.0);
      expect(result.imputedCount).toBe(2);
    });

    it('should impute all NaN features', () => {
      const config = createTestConfig({
        featureColumns: ['f1', 'f2'],
        coefficients: [1.0, 1.0],
        intercept: 0,
        featureMedians: { f1: 2.0, f2: 3.0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        f1: NaN,
        f2: NaN,
      });

      // All imputed: z = 0 + (1.0 * 2.0) + (1.0 * 3.0) = 5.0
      expect(result.linearCombination).toBe(5.0);
      expect(result.imputedCount).toBe(2);
    });

    it('should impute missing (undefined) features', () => {
      const config = createTestConfig({
        featureColumns: ['feature1', 'feature2'],
        coefficients: [1.0, 1.0],
        intercept: 0,
        featureMedians: { feature1: 5.0, feature2: 3.0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        feature1: 2.0,
        // feature2 is missing
      });

      // feature2 imputed with 3.0
      // z = 0 + (1.0 * 2.0) + (1.0 * 3.0) = 5.0
      expect(result.linearCombination).toBe(5.0);
      expect(result.imputedCount).toBe(1);
    });

    it('should impute when feature not present in map', () => {
      const config = createTestConfig({
        featureColumns: ['f1', 'f2'],
        coefficients: [1.0, 2.0],
        intercept: 1.0,
        featureMedians: { f1: 10.0, f2: 5.0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({}); // Empty feature map

      // Both imputed: z = 1.0 + (1.0 * 10.0) + (2.0 * 5.0) = 21.0
      expect(result.linearCombination).toBe(21.0);
      expect(result.imputedCount).toBe(2);
    });

    it('should throw error if median is missing for imputed feature', () => {
      const config = createTestConfig({
        featureColumns: ['feature1', 'feature2'],
        coefficients: [1.0, 1.0],
        intercept: 0,
        featureMedians: { feature1: 5.0 }, // feature2 median missing
      });
      const model = new Crypto15LRModel(config);

      expect(() =>
        model.predict({
          feature1: 1.0,
          feature2: NaN, // Will try to impute
        })
      ).toThrow("Missing median for feature 'feature2' during imputation");
    });

    it('should not increment imputedCount for valid zero values', () => {
      const model = new Crypto15LRModel(createTestConfig());

      const result = model.predict({
        feature1: 0,
        feature2: 0,
      });

      expect(result.imputedCount).toBe(0);
    });

    it('should not increment imputedCount for negative values', () => {
      const model = new Crypto15LRModel(createTestConfig());

      const result = model.predict({
        feature1: -5.0,
        feature2: -10.0,
      });

      expect(result.imputedCount).toBe(0);
    });
  });

  // ============================================================================
  // Prediction Tests - Boolean Features
  // ============================================================================

  describe('predict - boolean features', () => {
    it('should convert true to 1', () => {
      const config = createTestConfig({
        featureColumns: ['bool_feature'],
        coefficients: [2.0],
        intercept: 0,
        featureMedians: { bool_feature: 0.5 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ bool_feature: true });

      // z = 0 + (2.0 * 1) = 2.0
      expect(result.linearCombination).toBe(2.0);
      expect(result.imputedCount).toBe(0);
    });

    it('should convert false to 0', () => {
      const config = createTestConfig({
        featureColumns: ['bool_feature'],
        coefficients: [2.0],
        intercept: 0,
        featureMedians: { bool_feature: 0.5 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ bool_feature: false });

      // z = 0 + (2.0 * 0) = 0
      expect(result.linearCombination).toBe(0);
      expect(result.imputedCount).toBe(0);
    });

    it('should handle mixed boolean and numeric features', () => {
      const config = createTestConfig({
        featureColumns: ['is_active', 'score'],
        coefficients: [1.0, 0.5],
        intercept: 0,
        featureMedians: { is_active: 0.5, score: 10.0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        is_active: true,
        score: 6.0,
      });

      // z = 0 + (1.0 * 1) + (0.5 * 6.0) = 1 + 3 = 4.0
      expect(result.linearCombination).toBe(4.0);
    });

    it('should not treat boolean false as NaN for imputation', () => {
      const config = createTestConfig({
        featureColumns: ['bool_feature'],
        coefficients: [2.0],
        intercept: 0,
        featureMedians: { bool_feature: 1.0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ bool_feature: false });

      // Should use false (0), not impute with median (1.0)
      expect(result.linearCombination).toBe(0);
      expect(result.imputedCount).toBe(0);
    });
  });

  // ============================================================================
  // getConfig Tests
  // ============================================================================

  describe('getConfig', () => {
    it('should return a copy of the config', () => {
      const originalConfig = createTestConfig();
      const model = new Crypto15LRModel(originalConfig);

      const returnedConfig = model.getConfig();

      expect(returnedConfig.version).toBe('1.0.0');
      expect(returnedConfig.asset).toBe('BTC');
      expect(returnedConfig.featureColumns).toEqual(['feature1', 'feature2']);
      expect(returnedConfig.coefficients).toEqual([0.5, -0.3]);
      expect(returnedConfig.intercept).toBe(0.1);
    });

    it('should return a deep copy that prevents external mutation', () => {
      const model = new Crypto15LRModel(createTestConfig());
      const config1 = model.getConfig();

      // Mutate returned config
      (config1.coefficients as number[])[0] = 999;
      (config1.featureColumns as string[])[0] = 'mutated';
      (config1.featureMedians as Record<string, number>).feature1 = 999;

      // Get config again - should be unaffected
      const config2 = model.getConfig();
      expect(config2.coefficients[0]).toBe(0.5);
      expect(config2.featureColumns[0]).toBe('feature1');
      expect(config2.featureMedians.feature1).toBe(1.0);
    });
  });

  // ============================================================================
  // getAsset and getVersion Tests
  // ============================================================================

  describe('getAsset', () => {
    it('should return the asset name', () => {
      const model = new Crypto15LRModel(createTestConfig({ asset: 'ETH' }));
      expect(model.getAsset()).toBe('ETH');
    });
  });

  describe('getVersion', () => {
    it('should return the version string', () => {
      const model = new Crypto15LRModel(createTestConfig({ version: '2.5.0' }));
      expect(model.getVersion()).toBe('2.5.0');
    });
  });

  // ============================================================================
  // Edge Cases and Security
  // ============================================================================

  describe('edge cases and security', () => {
    it('should ignore extra features not in featureColumns', () => {
      const model = new Crypto15LRModel(createTestConfig());

      const result = model.predict({
        feature1: 2.0,
        feature2: 1.0,
        extraFeature: 1000.0, // Should be ignored
        anotherExtra: 9999.9,
      });

      // z = 0.1 + (0.5 * 2.0) + (-0.3 * 1.0) = 0.8
      expect(result.linearCombination).toBeCloseTo(0.8, 10);
    });

    it('should protect against prototype pollution via Object.hasOwn', () => {
      const model = new Crypto15LRModel(
        createTestConfig({
          featureColumns: ['constructor', 'toString'],
          coefficients: [1.0, 1.0],
          intercept: 0,
          featureMedians: { constructor: 0, toString: 0 },
        })
      );

      // These are prototype properties - should use medians
      const features: FeatureMap = {};

      const result = model.predict(features);

      expect(result.imputedCount).toBe(2);
    });

    it('should handle feature names with special characters', () => {
      const config = createTestConfig({
        featureColumns: ['feature-with-dash', 'feature.with.dots', 'feature_with_underscores'],
        coefficients: [1.0, 1.0, 1.0],
        intercept: 0,
        featureMedians: {
          'feature-with-dash': 1.0,
          'feature.with.dots': 2.0,
          feature_with_underscores: 3.0,
        },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({
        'feature-with-dash': 1.0,
        'feature.with.dots': 1.0,
        feature_with_underscores: 1.0,
      });

      expect(result.linearCombination).toBe(3.0);
      expect(result.imputedCount).toBe(0);
    });

    it('should handle very small coefficient values', () => {
      const config = createTestConfig({
        featureColumns: ['x'],
        coefficients: [1e-15],
        intercept: 0,
        featureMedians: { x: 0 },
      });
      const model = new Crypto15LRModel(config);

      const result = model.predict({ x: 1e15 });

      // z should be approximately 1.0
      expect(result.linearCombination).toBeCloseTo(1.0, 5);
    });
  });
});
