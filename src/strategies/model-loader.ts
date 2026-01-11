/**
 * Model Loader
 *
 * Utilities to load trained model artifacts from JSON files exported from Argus.
 * Handles loading and validation of:
 * - Model coefficients, intercepts, and feature columns (per-symbol)
 * - Imputation values (median values for NaN features per symbol)
 *
 * Security Note: These loader functions accept file paths directly. Ensure paths
 * come from trusted configuration sources, not user input, to prevent path
 * traversal attacks.
 *
 * Part of #3
 */

import { readFile } from 'node:fs/promises';
import { Crypto15LRModel, type ModelConfig } from './crypto15-lr-model.js';

// ============================================================================
// Constants
// ============================================================================

/** Default version when not specified in model file */
export const DEFAULT_MODEL_VERSION = '1.0.0';

/**
 * Quote currencies to strip when extracting asset from symbol.
 * IMPORTANT: Order matters - longer suffixes must come first to avoid
 * partial matches (e.g., 'USDT' before 'USD', otherwise 'BTCUSDT' would
 * incorrectly extract 'BTCUS' instead of 'BTC').
 *
 * Exported to allow customization if needed for other quote currencies.
 */
export const QUOTE_CURRENCIES = ['USDT', 'BUSD', 'USDC', 'USD'] as const;

// ============================================================================
// Error Types
// ============================================================================

/** Error codes for ModelLoaderError */
export enum ModelLoaderErrorCode {
  /** File could not be read from disk */
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  /** JSON parsing failed */
  JSON_PARSE_ERROR = 'JSON_PARSE_ERROR',
  /** Model file structure is invalid */
  MODEL_VALIDATION_ERROR = 'MODEL_VALIDATION_ERROR',
  /** Imputation file structure is invalid */
  IMPUTATION_VALIDATION_ERROR = 'IMPUTATION_VALIDATION_ERROR',
  /** Symbol in model has no matching imputation data */
  MISSING_IMPUTATION_ERROR = 'MISSING_IMPUTATION_ERROR',
}

/**
 * Typed error for model loader operations.
 * Allows callers to programmatically distinguish error types.
 */
export class ModelLoaderError extends Error {
  constructor(
    message: string,
    public readonly code: ModelLoaderErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ModelLoaderError';
  }
}

// ============================================================================
// Types - Model JSON Format (matches Argus export)
// ============================================================================

/**
 * Single symbol entry in the model JSON file
 */
export interface ModelFileSymbol {
  /** Trading pair symbol (e.g., "BTCUSDT") */
  readonly symbol: string;
  /** Model coefficients in feature column order */
  readonly coefficients: readonly number[];
  /** Model intercept (bias term) */
  readonly intercept: number;
  /** Feature column names in order */
  readonly feature_columns: readonly string[];
}

/**
 * Root structure of the model JSON file
 */
export interface ModelFile {
  /** Model version identifier */
  readonly version?: string;
  /** Array of per-symbol model configurations */
  readonly symbols: readonly ModelFileSymbol[];
}

/**
 * Imputation values format - maps symbol to feature medians
 */
export type ImputationFile = Readonly<Record<string, Readonly<Record<string, number>>>>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely extract error message from unknown caught value
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Read and parse a JSON file with proper error handling
 */
async function readJsonFile(path: string, description: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (e) {
    throw new ModelLoaderError(
      `Failed to read ${description} file: ${getErrorMessage(e)}`,
      ModelLoaderErrorCode.FILE_READ_ERROR,
      e
    );
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new ModelLoaderError(
      `Failed to parse ${description} JSON: ${getErrorMessage(e)}`,
      ModelLoaderErrorCode.JSON_PARSE_ERROR,
      e
    );
  }
}

/**
 * Extract asset from symbol (e.g., "BTCUSDT" -> "BTC")
 *
 * @param symbol - Trading pair symbol
 * @param quoteCurrencies - Quote currencies to strip (defaults to QUOTE_CURRENCIES)
 */
function extractAsset(
  symbol: string,
  quoteCurrencies: readonly string[] = QUOTE_CURRENCIES
): string {
  for (const quote of quoteCurrencies) {
    if (symbol.endsWith(quote)) {
      return symbol.slice(0, -quote.length);
    }
  }
  return symbol;
}

/**
 * Feature name mapping from model file format to feature engine format.
 *
 * The trained model (from Argus) uses different feature names than the
 * Crypto15FeatureEngine produces. This mapping translates model feature names
 * to engine feature names at load time for seamless integration.
 *
 * Pattern-based mappings (handled dynamically):
 * - has_up_hit_Xbps -> has_up_hit (threshold suffix stripped)
 * - has_down_hit_Xbps -> has_down_hit
 * - first_up_hit_minute_Xbps -> first_up_hit_minute
 * - first_down_hit_minute_Xbps -> first_down_hit_minute
 */
const FEATURE_NAME_MAP: Record<string, string> = {
  // Return features - model uses "prev" suffix
  return_prev_1m: 'return_1m',
  return_prev_3m: 'return_3m',
  return_prev_5m: 'return_5m',
};

/**
 * Pattern for threshold-suffixed feature names (e.g., has_up_hit_8bps)
 * Matches: has_up_hit_Xbps, has_down_hit_Xbps, first_up_hit_minute_Xbps, first_down_hit_minute_Xbps
 */
const THRESHOLD_SUFFIX_PATTERN = /^(has_up_hit|has_down_hit|first_up_hit_minute|first_down_hit_minute)_\d+bps$/;

/**
 * Map a model feature name to the corresponding feature engine name.
 * Returns the original name if no mapping exists.
 */
function mapFeatureName(modelFeatureName: string): string {
  // Check static mapping first
  if (FEATURE_NAME_MAP[modelFeatureName]) {
    return FEATURE_NAME_MAP[modelFeatureName];
  }

  // Check for threshold-suffixed pattern (e.g., has_up_hit_8bps -> has_up_hit)
  const match = modelFeatureName.match(THRESHOLD_SUFFIX_PATTERN);
  if (match) {
    return match[1]; // Return base name without suffix
  }

  // No mapping needed
  return modelFeatureName;
}

/**
 * Map medians object keys from model feature names to engine feature names.
 *
 * Note: Multiple model feature names may map to the same engine feature name
 * (e.g., threshold-suffixed features like `first_up_hit_minute_8bps` map to
 * `first_up_hit_minute`). When this occurs, the last value wins and a warning
 * is logged. This is expected behavior when loading per-asset imputations.
 */
function mapMedianKeys(medians: Record<string, number>): Record<string, number> {
  const mapped: Record<string, number> = {};
  for (const [key, value] of Object.entries(medians)) {
    const mappedKey = mapFeatureName(key);
    if (mappedKey in mapped) {
      console.warn(
        `[model-loader] Median key collision: "${key}" maps to "${mappedKey}" which already exists (previous value: ${mapped[mappedKey]}, new value: ${value})`
      );
    }
    mapped[mappedKey] = value;
  }
  return mapped;
}

/**
 * Create a Crypto15LRModel from a symbol entry and optional medians
 */
function createModel(
  symbolEntry: ModelFileSymbol,
  version: string,
  medians: Record<string, number> = {}
): Crypto15LRModel {
  // Map feature column names from model format to engine format
  const mappedFeatureColumns = symbolEntry.feature_columns.map(mapFeatureName);
  const mappedMedians = mapMedianKeys(medians);

  const config: ModelConfig = {
    version,
    asset: extractAsset(symbolEntry.symbol),
    featureColumns: mappedFeatureColumns,
    coefficients: [...symbolEntry.coefficients],
    intercept: symbolEntry.intercept,
    featureMedians: mappedMedians,
  };
  return new Crypto15LRModel(config);
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate model file structure
 * @throws ModelLoaderError if structure is invalid
 */
function validateModelFile(data: unknown): asserts data is ModelFile {
  if (!data || typeof data !== 'object') {
    throw new ModelLoaderError(
      'Model file must be a JSON object',
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  const file = data as Record<string, unknown>;

  if (!Array.isArray(file.symbols)) {
    throw new ModelLoaderError(
      'Model file must have a "symbols" array',
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  if (file.symbols.length === 0) {
    throw new ModelLoaderError(
      'Model file "symbols" array cannot be empty',
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  for (let i = 0; i < file.symbols.length; i++) {
    validateModelSymbol(file.symbols[i], i);
  }
}

/**
 * Validate a single symbol entry in the model file
 */
function validateModelSymbol(entry: unknown, index: number): asserts entry is ModelFileSymbol {
  if (!entry || typeof entry !== 'object') {
    throw new ModelLoaderError(
      `Symbol entry at index ${index} must be an object`,
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  const symbol = entry as Record<string, unknown>;

  if (typeof symbol.symbol !== 'string' || symbol.symbol.length === 0) {
    throw new ModelLoaderError(
      `Symbol entry at index ${index} must have a non-empty "symbol" string`,
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  if (!Array.isArray(symbol.coefficients) || symbol.coefficients.length === 0) {
    throw new ModelLoaderError(
      `Symbol "${symbol.symbol}" must have a non-empty "coefficients" array`,
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  for (let j = 0; j < symbol.coefficients.length; j++) {
    if (typeof symbol.coefficients[j] !== 'number' || !Number.isFinite(symbol.coefficients[j])) {
      throw new ModelLoaderError(
        `Symbol "${symbol.symbol}" coefficient at index ${j} must be a finite number`,
        ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
      );
    }
  }

  if (typeof symbol.intercept !== 'number' || !Number.isFinite(symbol.intercept)) {
    throw new ModelLoaderError(
      `Symbol "${symbol.symbol}" must have a finite "intercept" number`,
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  if (!Array.isArray(symbol.feature_columns) || symbol.feature_columns.length === 0) {
    throw new ModelLoaderError(
      `Symbol "${symbol.symbol}" must have a non-empty "feature_columns" array`,
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  if (symbol.coefficients.length !== symbol.feature_columns.length) {
    throw new ModelLoaderError(
      `Symbol "${symbol.symbol}" coefficients length (${symbol.coefficients.length}) must match feature_columns length (${symbol.feature_columns.length})`,
      ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
    );
  }

  for (let j = 0; j < symbol.feature_columns.length; j++) {
    if (typeof symbol.feature_columns[j] !== 'string' || symbol.feature_columns[j].length === 0) {
      throw new ModelLoaderError(
        `Symbol "${symbol.symbol}" feature_column at index ${j} must be a non-empty string`,
        ModelLoaderErrorCode.MODEL_VALIDATION_ERROR
      );
    }
  }
}

/**
 * Validate imputation file structure
 * @throws ModelLoaderError if structure is invalid
 */
function validateImputationFile(data: unknown): asserts data is ImputationFile {
  if (!data || typeof data !== 'object') {
    throw new ModelLoaderError(
      'Imputation file must be a JSON object',
      ModelLoaderErrorCode.IMPUTATION_VALIDATION_ERROR
    );
  }

  const file = data as Record<string, unknown>;

  if (Object.keys(file).length === 0) {
    throw new ModelLoaderError(
      'Imputation file cannot be empty',
      ModelLoaderErrorCode.IMPUTATION_VALIDATION_ERROR
    );
  }

  for (const [symbol, medians] of Object.entries(file)) {
    if (!medians || typeof medians !== 'object') {
      throw new ModelLoaderError(
        `Imputation for symbol "${symbol}" must be an object`,
        ModelLoaderErrorCode.IMPUTATION_VALIDATION_ERROR
      );
    }

    for (const [feature, value] of Object.entries(medians as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ModelLoaderError(
          `Imputation value for "${symbol}.${feature}" must be a finite number, got ${value}`,
          ModelLoaderErrorCode.IMPUTATION_VALIDATION_ERROR
        );
      }
    }
  }
}

// ============================================================================
// Loader Functions
// ============================================================================

/**
 * Load models from a JSON file
 *
 * Note: Models loaded this way have empty featureMedians. Use
 * loadModelsWithImputations() for production use with imputation support.
 *
 * @param path - Path to the model JSON file (must be from trusted source)
 * @returns Map of symbol to Crypto15LRModel instance
 * @throws ModelLoaderError if file cannot be read or JSON is malformed
 */
export async function loadModels(path: string): Promise<Map<string, Crypto15LRModel>> {
  const data = await readJsonFile(path, 'model');
  validateModelFile(data);

  const version = data.version ?? DEFAULT_MODEL_VERSION;
  const models = new Map<string, Crypto15LRModel>();

  for (const symbolEntry of data.symbols) {
    models.set(symbolEntry.symbol, createModel(symbolEntry, version));
  }

  return models;
}

/**
 * Load models from a JSON file with imputation values merged in
 *
 * This is the recommended loader for production use as it ensures
 * models have median values for feature imputation.
 *
 * @param modelPath - Path to the model JSON file (must be from trusted source)
 * @param imputationPath - Path to the imputation JSON file (must be from trusted source)
 * @returns Map of symbol to Crypto15LRModel instance with medians populated
 * @throws ModelLoaderError if files cannot be read or JSON is malformed
 */
export async function loadModelsWithImputations(
  modelPath: string,
  imputationPath: string
): Promise<Map<string, Crypto15LRModel>> {
  const [modelData, imputationData] = await Promise.all([
    readJsonFile(modelPath, 'model'),
    readJsonFile(imputationPath, 'imputation'),
  ]);

  validateModelFile(modelData);
  validateImputationFile(imputationData);

  const version = modelData.version ?? DEFAULT_MODEL_VERSION;
  const models = new Map<string, Crypto15LRModel>();

  for (const symbolEntry of modelData.symbols) {
    const medians = imputationData[symbolEntry.symbol];

    if (!medians) {
      throw new ModelLoaderError(
        `No imputation values found for symbol "${symbolEntry.symbol}"`,
        ModelLoaderErrorCode.MISSING_IMPUTATION_ERROR
      );
    }

    models.set(symbolEntry.symbol, createModel(symbolEntry, version, { ...medians }));
  }

  return models;
}

/**
 * Load imputation values from a JSON file
 *
 * Useful when you need to load imputations separately from models,
 * e.g., for inspection or when combining with models loaded elsewhere.
 *
 * @param path - Path to the imputation JSON file (must be from trusted source)
 * @returns Map of symbol to feature medians record
 * @throws ModelLoaderError if file cannot be read or JSON is malformed
 */
export async function loadImputations(path: string): Promise<Map<string, Record<string, number>>> {
  const data = await readJsonFile(path, 'imputation');
  validateImputationFile(data);

  const imputations = new Map<string, Record<string, number>>();

  for (const [symbol, medians] of Object.entries(data)) {
    // Store reference directly - data is freshly parsed and won't be reused
    imputations.set(symbol, medians);
  }

  return imputations;
}
