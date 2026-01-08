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

// ============================================================================
// Types
// ============================================================================

/**
 * Feature map format for model consumption.
 * Defined locally to decouple model from feature engine implementation.
 */
export type FeatureMap = Record<string, number | boolean>;

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

/**
 * Default value used when a feature is missing and no median is available.
 * Using 0 is a neutral choice for centered/standardized features, as it
 * represents the mean of a standard normal distribution.
 */
const DEFAULT_MISSING_FEATURE_VALUE = 0;

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
    // Cache config properties to avoid repeated property chain lookups in hot path
    const { featureColumns, coefficients, featureMedians, intercept } = this.config;

    let z = intercept;
    let imputedCount = 0;

    for (let i = 0; i < featureColumns.length; i++) {
      const column = featureColumns[i];
      const coefficient = coefficients[i];

      // Use Object.hasOwn to protect against prototype pollution
      const rawValue = Object.hasOwn(features, column) ? features[column] : undefined;

      let featureValue: number;

      // Handle missing or NaN values via imputation
      if (rawValue === undefined || this.isNaNValue(rawValue)) {
        const median = featureMedians[column];
        featureValue = median !== undefined ? median : DEFAULT_MISSING_FEATURE_VALUE;
        imputedCount++;
      } else {
        // Convert boolean to number, pass through numeric values
        featureValue = typeof rawValue === 'boolean' ? (rawValue ? 1 : 0) : rawValue;
      }

      z += coefficient * featureValue;
    }

    const probability = this.sigmoid(z);

    return {
      probability,
      imputedCount,
      linearCombination: z,
    };
  }

  /**
   * Get a copy of the model configuration.
   * Returns a deep copy to prevent external mutation of internal state.
   */
  getConfig(): Readonly<ModelConfig> {
    return {
      ...this.config,
      featureColumns: [...this.config.featureColumns],
      coefficients: [...this.config.coefficients],
      featureMedians: { ...this.config.featureMedians },
    };
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

    this.assertNonEmptyString(config.version, 'version');
    this.assertNonEmptyString(config.asset, 'asset');
    this.assertNonEmptyArray(config.featureColumns, 'featureColumns');
    this.assertNonEmptyArray(config.coefficients, 'coefficients');

    if (config.featureColumns.length !== config.coefficients.length) {
      throw new Error(
        `Feature columns length (${config.featureColumns.length}) must match coefficients length (${config.coefficients.length})`
      );
    }

    this.assertFiniteNumber(config.intercept, 'intercept');

    if (!config.featureMedians || typeof config.featureMedians !== 'object') {
      throw new Error('Model config must have featureMedians object');
    }

    // Validate all coefficients are finite numbers
    for (let i = 0; i < config.coefficients.length; i++) {
      this.assertFiniteNumber(config.coefficients[i], `coefficient at index ${i}`);
    }

    // Validate all feature column names are non-empty strings
    for (let i = 0; i < config.featureColumns.length; i++) {
      this.assertNonEmptyString(config.featureColumns[i], `feature column at index ${i}`);
    }

    // Validate all medians are finite numbers
    for (const [key, value] of Object.entries(config.featureMedians)) {
      this.assertFiniteNumber(value, `feature median for '${key}'`);
    }
  }

  /**
   * Assert that a value is a non-empty string
   */
  private assertNonEmptyString(value: unknown, fieldName: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Model config must have a non-empty ${fieldName} string`);
    }
  }

  /**
   * Assert that a value is a non-empty array
   */
  private assertNonEmptyArray(value: unknown, fieldName: string): void {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`Model config must have non-empty ${fieldName} array`);
    }
  }

  /**
   * Assert that a value is a finite number
   */
  private assertFiniteNumber(value: unknown, fieldName: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Model config ${fieldName} must be a finite number`);
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
   * Check if a value is NaN (handles both number NaN and boolean values)
   */
  private isNaNValue(value: number | boolean): boolean {
    if (typeof value === 'boolean') {
      return false;
    }
    return Number.isNaN(value);
  }
}
