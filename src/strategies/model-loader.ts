/**
 * Model Loader
 *
 * Utilities to load trained model artifacts from JSON files exported from Argus.
 * Handles loading and validation of:
 * - Model coefficients, intercepts, and feature columns (per-symbol)
 * - Imputation values (median values for NaN features per symbol)
 *
 * Part of #3
 */

import { readFile } from 'node:fs/promises';
import { Crypto15LRModel, type ModelConfig } from './crypto15-lr-model.js';

// ============================================================================
// Types - Model JSON Format (matches Argus export)
// ============================================================================

/**
 * Single symbol entry in the model JSON file
 */
export interface ModelFileSymbol {
  /** Trading pair symbol (e.g., "BTCUSDT") */
  symbol: string;
  /** Model coefficients in feature column order */
  coefficients: number[];
  /** Model intercept (bias term) */
  intercept: number;
  /** Feature column names in order */
  feature_columns: string[];
}

/**
 * Root structure of the model JSON file
 */
export interface ModelFile {
  /** Model version identifier */
  version?: string;
  /** Array of per-symbol model configurations */
  symbols: ModelFileSymbol[];
}

/**
 * Imputation values format - maps symbol to feature medians
 */
export type ImputationFile = Record<string, Record<string, number>>;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Extract asset from symbol (e.g., "BTCUSDT" -> "BTC")
 */
function extractAsset(symbol: string): string {
  // Common quote currencies to strip
  const quoteCurrencies = ['USDT', 'BUSD', 'USD', 'USDC'];
  for (const quote of quoteCurrencies) {
    if (symbol.endsWith(quote)) {
      return symbol.slice(0, -quote.length);
    }
  }
  return symbol;
}

/**
 * Validate model file structure
 * @throws Error if structure is invalid
 */
function validateModelFile(data: unknown): asserts data is ModelFile {
  if (!data || typeof data !== 'object') {
    throw new Error('Model file must be a JSON object');
  }

  const file = data as Record<string, unknown>;

  if (!Array.isArray(file.symbols)) {
    throw new Error('Model file must have a "symbols" array');
  }

  if (file.symbols.length === 0) {
    throw new Error('Model file "symbols" array cannot be empty');
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
    throw new Error(`Symbol entry at index ${index} must be an object`);
  }

  const symbol = entry as Record<string, unknown>;

  if (typeof symbol.symbol !== 'string' || symbol.symbol.length === 0) {
    throw new Error(`Symbol entry at index ${index} must have a non-empty "symbol" string`);
  }

  if (!Array.isArray(symbol.coefficients) || symbol.coefficients.length === 0) {
    throw new Error(`Symbol "${symbol.symbol}" must have a non-empty "coefficients" array`);
  }

  for (let j = 0; j < symbol.coefficients.length; j++) {
    if (typeof symbol.coefficients[j] !== 'number' || !Number.isFinite(symbol.coefficients[j])) {
      throw new Error(
        `Symbol "${symbol.symbol}" coefficient at index ${j} must be a finite number`
      );
    }
  }

  if (typeof symbol.intercept !== 'number' || !Number.isFinite(symbol.intercept)) {
    throw new Error(`Symbol "${symbol.symbol}" must have a finite "intercept" number`);
  }

  if (!Array.isArray(symbol.feature_columns) || symbol.feature_columns.length === 0) {
    throw new Error(`Symbol "${symbol.symbol}" must have a non-empty "feature_columns" array`);
  }

  if (symbol.coefficients.length !== symbol.feature_columns.length) {
    throw new Error(
      `Symbol "${symbol.symbol}" coefficients length (${symbol.coefficients.length}) must match feature_columns length (${symbol.feature_columns.length})`
    );
  }

  for (let j = 0; j < symbol.feature_columns.length; j++) {
    if (typeof symbol.feature_columns[j] !== 'string' || symbol.feature_columns[j].length === 0) {
      throw new Error(
        `Symbol "${symbol.symbol}" feature_column at index ${j} must be a non-empty string`
      );
    }
  }
}

/**
 * Validate imputation file structure
 * @throws Error if structure is invalid
 */
function validateImputationFile(data: unknown): asserts data is ImputationFile {
  if (!data || typeof data !== 'object') {
    throw new Error('Imputation file must be a JSON object');
  }

  const file = data as Record<string, unknown>;

  if (Object.keys(file).length === 0) {
    throw new Error('Imputation file cannot be empty');
  }

  for (const [symbol, medians] of Object.entries(file)) {
    if (!medians || typeof medians !== 'object') {
      throw new Error(`Imputation for symbol "${symbol}" must be an object`);
    }

    for (const [feature, value] of Object.entries(medians as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `Imputation value for "${symbol}.${feature}" must be a finite number, got ${value}`
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
 * @param path - Path to the model JSON file
 * @returns Map of symbol to Crypto15LRModel instance
 * @throws Error if file cannot be read or JSON is malformed
 */
export async function loadModels(path: string): Promise<Map<string, Crypto15LRModel>> {
  const content = await readFile(path, 'utf-8');
  let data: unknown;

  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse model JSON: ${(e as Error).message}`);
  }

  validateModelFile(data);

  const models = new Map<string, Crypto15LRModel>();

  for (const symbolEntry of data.symbols) {
    const asset = extractAsset(symbolEntry.symbol);

    const config: ModelConfig = {
      version: data.version ?? '1.0.0',
      asset,
      featureColumns: symbolEntry.feature_columns,
      coefficients: symbolEntry.coefficients,
      intercept: symbolEntry.intercept,
      // Feature medians will be set later via loadImputations
      // For now, use empty object - caller should merge imputation data
      featureMedians: {},
    };

    const model = new Crypto15LRModel(config);
    models.set(symbolEntry.symbol, model);
  }

  return models;
}

/**
 * Load models from a JSON file with imputation values merged in
 *
 * @param modelPath - Path to the model JSON file
 * @param imputationPath - Path to the imputation JSON file
 * @returns Map of symbol to Crypto15LRModel instance with medians populated
 * @throws Error if files cannot be read or JSON is malformed
 */
export async function loadModelsWithImputations(
  modelPath: string,
  imputationPath: string
): Promise<Map<string, Crypto15LRModel>> {
  const [modelContent, imputationContent] = await Promise.all([
    readFile(modelPath, 'utf-8'),
    readFile(imputationPath, 'utf-8'),
  ]);

  let modelData: unknown;
  let imputationData: unknown;

  try {
    modelData = JSON.parse(modelContent);
  } catch (e) {
    throw new Error(`Failed to parse model JSON: ${(e as Error).message}`);
  }

  try {
    imputationData = JSON.parse(imputationContent);
  } catch (e) {
    throw new Error(`Failed to parse imputation JSON: ${(e as Error).message}`);
  }

  validateModelFile(modelData);
  validateImputationFile(imputationData);

  const models = new Map<string, Crypto15LRModel>();

  for (const symbolEntry of modelData.symbols) {
    const asset = extractAsset(symbolEntry.symbol);
    const medians = imputationData[symbolEntry.symbol];

    if (!medians) {
      throw new Error(`No imputation values found for symbol "${symbolEntry.symbol}"`);
    }

    const config: ModelConfig = {
      version: modelData.version ?? '1.0.0',
      asset,
      featureColumns: symbolEntry.feature_columns,
      coefficients: symbolEntry.coefficients,
      intercept: symbolEntry.intercept,
      featureMedians: medians,
    };

    const model = new Crypto15LRModel(config);
    models.set(symbolEntry.symbol, model);
  }

  return models;
}

/**
 * Load imputation values from a JSON file
 *
 * @param path - Path to the imputation JSON file
 * @returns Map of symbol to feature medians record
 * @throws Error if file cannot be read or JSON is malformed
 */
export async function loadImputations(path: string): Promise<Map<string, Record<string, number>>> {
  const content = await readFile(path, 'utf-8');
  let data: unknown;

  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse imputation JSON: ${(e as Error).message}`);
  }

  validateImputationFile(data);

  const imputations = new Map<string, Record<string, number>>();

  for (const [symbol, medians] of Object.entries(data)) {
    imputations.set(symbol, { ...medians });
  }

  return imputations;
}
