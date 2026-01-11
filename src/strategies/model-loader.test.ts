/**
 * Model Loader Unit Tests
 *
 * Tests loading and validation of model artifacts from JSON files.
 *
 * Part of #3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadModels,
  loadImputations,
  loadModelsWithImputations,
  ModelLoaderError,
  ModelLoaderErrorCode,
  DEFAULT_MODEL_VERSION,
} from './model-loader.js';

describe('Model Loader', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create unique temp directory for each test using mkdtemp (guarantees uniqueness)
    testDir = await mkdtemp(join(tmpdir(), 'model-loader-test-'));
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(testDir, { recursive: true, force: true });
  });

  // ============================================================================
  // Sample Data
  // ============================================================================

  const sampleModelFile = {
    version: '1.0.0',
    symbols: [
      {
        symbol: 'BTCUSDT',
        coefficients: [0.5, -0.3, 0.2],
        intercept: -0.234,
        feature_columns: ['volatility_5m', 'return_prev_5m', 'rsi_14'],
      },
      {
        symbol: 'ETHUSDT',
        coefficients: [0.4, -0.2, 0.1],
        intercept: -0.123,
        feature_columns: ['volatility_5m', 'return_prev_5m', 'rsi_14'],
      },
    ],
  };

  const sampleImputationFile = {
    BTCUSDT: {
      volatility_5m: 0.0012,
      return_prev_5m: 0.0,
      rsi_14: 50.0,
    },
    ETHUSDT: {
      volatility_5m: 0.0015,
      return_prev_5m: 0.0,
      rsi_14: 48.0,
    },
  };

  // ============================================================================
  // loadModels Tests
  // ============================================================================

  describe('loadModels', () => {
    it('should load models from valid JSON file', async () => {
      const filePath = join(testDir, 'models.json');
      await writeFile(filePath, JSON.stringify(sampleModelFile));

      const models = await loadModels(filePath);

      expect(models.size).toBe(2);
      expect(models.has('BTCUSDT')).toBe(true);
      expect(models.has('ETHUSDT')).toBe(true);

      const btcModel = models.get('BTCUSDT')!;
      expect(btcModel.getAsset()).toBe('BTC');
      expect(btcModel.getVersion()).toBe('1.0.0');

      const ethModel = models.get('ETHUSDT')!;
      expect(ethModel.getAsset()).toBe('ETH');
    });

    it('should use default version if not provided', async () => {
      const fileWithoutVersion = {
        symbols: sampleModelFile.symbols,
      };
      const filePath = join(testDir, 'models.json');
      await writeFile(filePath, JSON.stringify(fileWithoutVersion));

      const models = await loadModels(filePath);
      const btcModel = models.get('BTCUSDT')!;

      expect(btcModel.getVersion()).toBe(DEFAULT_MODEL_VERSION);
    });

    it('should extract asset from various symbol formats', async () => {
      const multiFormatFile = {
        version: '1.0.0',
        symbols: [
          {
            symbol: 'BTCUSDT',
            coefficients: [0.5],
            intercept: 0,
            feature_columns: ['test'],
          },
          {
            symbol: 'ETHBUSD',
            coefficients: [0.5],
            intercept: 0,
            feature_columns: ['test'],
          },
          {
            symbol: 'SOLUSD',
            coefficients: [0.5],
            intercept: 0,
            feature_columns: ['test'],
          },
          {
            symbol: 'XRPUSDC',
            coefficients: [0.5],
            intercept: 0,
            feature_columns: ['test'],
          },
        ],
      };

      const modelPath = join(testDir, 'models.json');
      await writeFile(modelPath, JSON.stringify(multiFormatFile));

      const models = await loadModels(modelPath);

      expect(models.get('BTCUSDT')!.getAsset()).toBe('BTC');
      expect(models.get('ETHBUSD')!.getAsset()).toBe('ETH');
      expect(models.get('SOLUSD')!.getAsset()).toBe('SOL');
      expect(models.get('XRPUSDC')!.getAsset()).toBe('XRP');
    });

    it('should throw FILE_READ_ERROR for non-existent file', async () => {
      try {
        await loadModels('/nonexistent/path.json');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelLoaderError);
        expect((e as ModelLoaderError).code).toBe(ModelLoaderErrorCode.FILE_READ_ERROR);
      }
    });

    it('should throw JSON_PARSE_ERROR for invalid JSON', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(filePath, 'not valid json');

      try {
        await loadModels(filePath);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelLoaderError);
        expect((e as ModelLoaderError).code).toBe(ModelLoaderErrorCode.JSON_PARSE_ERROR);
        expect((e as ModelLoaderError).message).toContain('Failed to parse model JSON');
      }
    });

    it('should throw for missing symbols array', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(filePath, JSON.stringify({ version: '1.0.0' }));

      await expect(loadModels(filePath)).rejects.toThrow('must have a "symbols" array');
    });

    it('should throw for empty symbols array', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(filePath, JSON.stringify({ symbols: [] }));

      await expect(loadModels(filePath)).rejects.toThrow('"symbols" array cannot be empty');
    });

    it('should throw for missing symbol name', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(
        filePath,
        JSON.stringify({
          symbols: [{ coefficients: [0.5], intercept: 0, feature_columns: ['test'] }],
        })
      );

      await expect(loadModels(filePath)).rejects.toThrow('must have a non-empty "symbol"');
    });

    it('should throw for non-finite coefficient', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(
        filePath,
        JSON.stringify({
          symbols: [
            {
              symbol: 'BTCUSDT',
              coefficients: [0.5, Infinity],
              intercept: 0,
              feature_columns: ['a', 'b'],
            },
          ],
        })
      );

      await expect(loadModels(filePath)).rejects.toThrow('must be a finite number');
    });

    it('should throw for mismatched coefficients and feature_columns length', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(
        filePath,
        JSON.stringify({
          symbols: [
            {
              symbol: 'BTCUSDT',
              coefficients: [0.5, 0.3],
              intercept: 0,
              feature_columns: ['a'],
            },
          ],
        })
      );

      await expect(loadModels(filePath)).rejects.toThrow('must match feature_columns length');
    });
  });

  // ============================================================================
  // loadImputations Tests
  // ============================================================================

  describe('loadImputations', () => {
    it('should load imputations from valid JSON file', async () => {
      const filePath = join(testDir, 'imputations.json');
      await writeFile(filePath, JSON.stringify(sampleImputationFile));

      const imputations = await loadImputations(filePath);

      expect(imputations.size).toBe(2);
      expect(imputations.has('BTCUSDT')).toBe(true);
      expect(imputations.has('ETHUSDT')).toBe(true);

      const btcImputations = imputations.get('BTCUSDT')!;
      expect(btcImputations.volatility_5m).toBe(0.0012);
      expect(btcImputations.return_prev_5m).toBe(0.0);
      expect(btcImputations.rsi_14).toBe(50.0);
    });

    it('should return fresh data on each load', async () => {
      const filePath = join(testDir, 'imputations.json');
      await writeFile(filePath, JSON.stringify(sampleImputationFile));

      const imputations = await loadImputations(filePath);
      const btcImputations = imputations.get('BTCUSDT')!;

      // Modify returned object
      btcImputations.volatility_5m = 999;

      // Load again - should return fresh parsed data
      const imputations2 = await loadImputations(filePath);
      expect(imputations2.get('BTCUSDT')!.volatility_5m).toBe(0.0012);
    });

    it('should throw FILE_READ_ERROR for non-existent file', async () => {
      try {
        await loadImputations('/nonexistent/path.json');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelLoaderError);
        expect((e as ModelLoaderError).code).toBe(ModelLoaderErrorCode.FILE_READ_ERROR);
      }
    });

    it('should throw JSON_PARSE_ERROR for invalid JSON', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(filePath, 'not valid json');

      try {
        await loadImputations(filePath);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelLoaderError);
        expect((e as ModelLoaderError).code).toBe(ModelLoaderErrorCode.JSON_PARSE_ERROR);
        expect((e as ModelLoaderError).message).toContain('Failed to parse imputation JSON');
      }
    });

    it('should throw IMPUTATION_VALIDATION_ERROR for empty object', async () => {
      const filePath = join(testDir, 'empty.json');
      await writeFile(filePath, JSON.stringify({}));

      await expect(loadImputations(filePath)).rejects.toThrow('cannot be empty');
    });

    it('should throw for non-object symbol entry', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(filePath, JSON.stringify({ BTCUSDT: 'not an object' }));

      await expect(loadImputations(filePath)).rejects.toThrow('must be an object');
    });

    it('should throw for non-finite imputation value', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFile(
        filePath,
        JSON.stringify({
          BTCUSDT: { volatility_5m: NaN },
        })
      );

      await expect(loadImputations(filePath)).rejects.toThrow('must be a finite number');
    });
  });

  // ============================================================================
  // loadModelsWithImputations Tests
  // ============================================================================

  describe('loadModelsWithImputations', () => {
    it('should load models with imputation values merged', async () => {
      const modelPath = join(testDir, 'models.json');
      const imputationPath = join(testDir, 'imputations.json');
      await writeFile(modelPath, JSON.stringify(sampleModelFile));
      await writeFile(imputationPath, JSON.stringify(sampleImputationFile));

      const models = await loadModelsWithImputations(modelPath, imputationPath);

      expect(models.size).toBe(2);

      const btcModel = models.get('BTCUSDT')!;
      const config = btcModel.getConfig();

      expect(config.featureMedians.volatility_5m).toBe(0.0012);
      // Note: return_prev_5m is mapped to return_5m by model-loader
      expect(config.featureMedians.return_5m).toBe(0.0);
      expect(config.featureMedians.rsi_14).toBe(50.0);
    });

    it('should allow prediction with imputed values', async () => {
      const modelPath = join(testDir, 'models.json');
      const imputationPath = join(testDir, 'imputations.json');
      await writeFile(modelPath, JSON.stringify(sampleModelFile));
      await writeFile(imputationPath, JSON.stringify(sampleImputationFile));

      const models = await loadModelsWithImputations(modelPath, imputationPath);
      const btcModel = models.get('BTCUSDT')!;

      // Predict with all values provided
      // Note: model-loader maps return_prev_5m to return_5m, so use mapped name
      const result1 = btcModel.predict({
        volatility_5m: 0.001,
        return_5m: 0.01,
        rsi_14: 55,
      });
      expect(result1.imputedCount).toBe(0);
      expect(result1.probability).toBeGreaterThan(0);
      expect(result1.probability).toBeLessThan(1);

      // Predict with missing value (should use imputation)
      const result2 = btcModel.predict({
        volatility_5m: 0.001,
        return_5m: 0.01,
        // rsi_14 is missing
      });
      expect(result2.imputedCount).toBe(1);
    });

    it('should throw MISSING_IMPUTATION_ERROR if imputation missing for symbol', async () => {
      const modelPath = join(testDir, 'models.json');
      const imputationPath = join(testDir, 'imputations.json');

      // Only include BTCUSDT imputation, not ETHUSDT
      const partialImputations = {
        BTCUSDT: sampleImputationFile.BTCUSDT,
      };

      await writeFile(modelPath, JSON.stringify(sampleModelFile));
      await writeFile(imputationPath, JSON.stringify(partialImputations));

      try {
        await loadModelsWithImputations(modelPath, imputationPath);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelLoaderError);
        expect((e as ModelLoaderError).code).toBe(ModelLoaderErrorCode.MISSING_IMPUTATION_ERROR);
        expect((e as ModelLoaderError).message).toContain('ETHUSDT');
      }
    });

    it('should throw for invalid model file', async () => {
      const modelPath = join(testDir, 'models.json');
      const imputationPath = join(testDir, 'imputations.json');
      await writeFile(modelPath, 'invalid json');
      await writeFile(imputationPath, JSON.stringify(sampleImputationFile));

      await expect(loadModelsWithImputations(modelPath, imputationPath)).rejects.toThrow(
        'Failed to parse model JSON'
      );
    });

    it('should throw for invalid imputation file', async () => {
      const modelPath = join(testDir, 'models.json');
      const imputationPath = join(testDir, 'imputations.json');
      await writeFile(modelPath, JSON.stringify(sampleModelFile));
      await writeFile(imputationPath, 'invalid json');

      await expect(loadModelsWithImputations(modelPath, imputationPath)).rejects.toThrow(
        'Failed to parse imputation JSON'
      );
    });
  });
});
