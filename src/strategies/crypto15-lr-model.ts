/**
 * Crypto15LRModel
 *
 * Logistic regression model for the 15-minute binary crypto market strategy.
 * Performs inference using pre-trained coefficients from Argus.
 *
 * Key responsibilities:
 * - Load model configuration (coefficients, intercept, feature columns)
 * - Run logistic regression inference: z = intercept + sum(coef[i] * feature[i])
 * - Apply sigmoid transformation: p = 1 / (1 + e^(-z))
 * - Handle missing features via imputation (use median values from training)
 * - Return probability + imputation count
 * - Numerical stability (handle z > 20 and z < -20)
 */

import { FeatureMap } from './crypto15-feature-engine.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Model configuration loaded from JSON artifact
 */
export interface ModelConfig {
  /** Model version identifier */
  version: string;
  /** Target asset symbol (BTC, ETH, SOL, XRP) */
  asset: string;
  /** Feature column names in order */
  featureColumns: string[];
  /** Coefficients for each feature (same order as featureColumns) */
  coefficients: number[];
  /** Model intercept (bias term) */
  intercept: number;
  /** Median values for imputation (keyed by feature name) */
  featureMedians: Record<string, number>;
}

/**
 * Result from model prediction
 */
export interface PredictionResult {
  /** Probability of UP outcome [0, 1] */
  probability: number;
  /** Number of features that were imputed due to NaN values */
  imputedCount: number;
  /** Linear combination z value (before sigmoid) */
  linearCombination: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Numerical stability thresholds for sigmoid function.
 * Values beyond these thresholds are clamped to avoid overflow/underflow.
 */
const SIGMOID_UPPER_BOUND = 20;
const SIGMOID_LOWER_BOUND = -20;

// ============================================================================
// Crypto15LRModel Implementation
// ============================================================================

export class Crypto15LRModel {
  private readonly config: ModelConfig;

  /**
   * Create a new LR model instance
   *
   * @param config - Model configuration with coefficients and feature columns
   * @throws Error if configuration is invalid
   */
  constructor(config: ModelConfig) {
    this.validateConfig(config);
    this.config = config;
  }

  /**
   * Run inference on a feature vector
   *
   * @param features - Feature map with values for each feature column
   * @returns Prediction result with probability and imputation count
   */
  predict(features: FeatureMap): PredictionResult {
    let z = this.config.intercept;
    let imputedCount = 0;

    for (let i = 0; i < this.config.featureColumns.length; i++) {
      const column = this.config.featureColumns[i];
      const coefficient = this.config.coefficients[i];
      let value = features[column];

      // Handle missing or NaN values via imputation
      if (value === undefined || value === null || this.isNaNValue(value)) {
        const median = this.config.featureMedians[column];
        if (median === undefined) {
          // No median available, use 0 as fallback
          value = 0;
        } else {
          value = median;
        }
        imputedCount++;
      }

      // Ensure value is a number for computation
      const numValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;
      z += coefficient * numValue;
    }

    const probability = this.sigmoid(z);

    return {
      probability,
      imputedCount,
      linearCombination: z,
    };
  }

  /**
   * Get the model configuration
   */
  getConfig(): ModelConfig {
    return this.config;
  }

  /**
   * Get the asset this model is for
   */
  getAsset(): string {
    return this.config.asset;
  }

  /**
   * Get the model version
   */
  getVersion(): string {
    return this.config.version;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Validate model configuration
   *
   * @throws Error if configuration is invalid
   */
  private validateConfig(config: ModelConfig): void {
    if (!config) {
      throw new Error('Model config is required');
    }

    if (!config.version || typeof config.version !== 'string') {
      throw new Error('Model config must have a version string');
    }

    if (!config.asset || typeof config.asset !== 'string') {
      throw new Error('Model config must have an asset string');
    }

    if (!Array.isArray(config.featureColumns) || config.featureColumns.length === 0) {
      throw new Error('Model config must have non-empty featureColumns array');
    }

    if (!Array.isArray(config.coefficients) || config.coefficients.length === 0) {
      throw new Error('Model config must have non-empty coefficients array');
    }

    if (config.featureColumns.length !== config.coefficients.length) {
      throw new Error(
        `Feature columns length (${config.featureColumns.length}) must match coefficients length (${config.coefficients.length})`
      );
    }

    if (typeof config.intercept !== 'number' || !Number.isFinite(config.intercept)) {
      throw new Error('Model config must have a finite intercept number');
    }

    if (!config.featureMedians || typeof config.featureMedians !== 'object') {
      throw new Error('Model config must have featureMedians object');
    }

    // Validate all coefficients are finite numbers
    for (let i = 0; i < config.coefficients.length; i++) {
      if (typeof config.coefficients[i] !== 'number' || !Number.isFinite(config.coefficients[i])) {
        throw new Error(`Coefficient at index ${i} must be a finite number`);
      }
    }

    // Validate all feature column names are non-empty strings
    for (let i = 0; i < config.featureColumns.length; i++) {
      if (typeof config.featureColumns[i] !== 'string' || config.featureColumns[i].length === 0) {
        throw new Error(`Feature column at index ${i} must be a non-empty string`);
      }
    }

    // Validate all medians are finite numbers
    for (const [key, value] of Object.entries(config.featureMedians)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Feature median for '${key}' must be a finite number`);
      }
    }
  }

  /**
   * Sigmoid function with numerical stability
   *
   * For extreme values:
   * - z > 20: returns 1.0 (e^(-20) is negligible)
   * - z < -20: returns 0.0 (e^(20) dominates)
   *
   * @param z - Linear combination value
   * @returns Probability in [0, 1] range
   */
  private sigmoid(z: number): number {
    if (z > SIGMOID_UPPER_BOUND) {
      return 1.0;
    }
    if (z < SIGMOID_LOWER_BOUND) {
      return 0.0;
    }
    return 1 / (1 + Math.exp(-z));
  }

  /**
   * Check if a value is NaN (handles both number NaN and NaN-like values)
   */
  private isNaNValue(value: number | boolean): boolean {
    if (typeof value === 'boolean') {
      return false;
    }
    return Number.isNaN(value);
  }
}
