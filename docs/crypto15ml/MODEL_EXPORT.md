# Crypto15ML Model Export Guide

How to export trained models from Argus for use with Crypto15MLStrategyService.

## Overview

The Crypto15ML strategy requires two JSON files:
1. **Model file** - Coefficients, intercept, and feature columns
2. **Imputation file** - Median values for missing features

## JSON Format Specification

### Model File (`crypto15ml_model.json`)

```json
{
  "version": "1.0.0",
  "asset": "BTCUSDT",
  "featureColumns": [
    "state_minute",
    "minutes_remaining",
    "hour_of_day",
    "day_of_week",
    "return_since_open",
    "max_run_up",
    "max_run_down",
    "return_1m",
    "return_3m",
    "return_5m",
    "volatility_5m",
    "has_up_hit",
    "has_down_hit",
    "first_up_hit_minute",
    "first_down_hit_minute",
    "asset",
    "timestamp"
  ],
  "coefficients": [
    0.123,
    -0.045,
    0.078,
    // ... one coefficient per feature
  ],
  "intercept": -0.234,
  "featureMedians": {
    "state_minute": 7,
    "minutes_remaining": 8,
    "hour_of_day": 12,
    "day_of_week": 3,
    "return_since_open": 0.0,
    "max_run_up": 0.001,
    "max_run_down": -0.001,
    "return_1m": 0.0,
    "return_3m": 0.0,
    "return_5m": 0.0,
    "volatility_5m": 0.0005,
    "has_up_hit": 0,
    "has_down_hit": 0,
    "first_up_hit_minute": 7,
    "first_down_hit_minute": 7,
    "asset": 0,
    "timestamp": 1704067200000
  }
}
```

### Imputation File (`crypto15ml_imputations.json`)

```json
{
  "version": "1.0.0",
  "imputations": {
    "BTCUSDT": {
      "state_minute": 7,
      "minutes_remaining": 8,
      "return_since_open": 0.0,
      "max_run_up": 0.001,
      "max_run_down": -0.001,
      "return_1m": 0.0,
      "return_3m": 0.0,
      "return_5m": 0.0,
      "volatility_5m": 0.0005,
      "first_up_hit_minute": 7,
      "first_down_hit_minute": 7
    },
    "ETHUSDT": {
      // Same structure for ETH
    },
    "SOLUSDT": {
      // Same structure for SOL
    },
    "XRPUSDT": {
      // Same structure for XRP
    }
  }
}
```

## Field Descriptions

### Model Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Model version (semver format) |
| `asset` | string | Target asset symbol |
| `featureColumns` | string[] | Feature names in order |
| `coefficients` | number[] | Model weights (same order as featureColumns) |
| `intercept` | number | Bias term (b in z = wx + b) |
| `featureMedians` | object | Median values for imputation |

### Feature Columns

| Feature | Type | Range | Description |
|---------|------|-------|-------------|
| `state_minute` | number | 0-14 | Minute within 15-min window |
| `minutes_remaining` | number | 1-15 | Minutes until window ends |
| `hour_of_day` | number | 0-23 | UTC hour |
| `day_of_week` | number | 0-6 | 0=Sunday, 6=Saturday |
| `return_since_open` | number | -1 to 1 | Return from window open |
| `max_run_up` | number | 0 to 1 | Maximum return reached |
| `max_run_down` | number | -1 to 0 | Minimum return reached |
| `return_1m` | number | -1 to 1 | 1-minute lagged return |
| `return_3m` | number | -1 to 1 | 3-minute lagged return |
| `return_5m` | number | -1 to 1 | 5-minute lagged return |
| `volatility_5m` | number | 0+ | 5-minute rolling volatility |
| `has_up_hit` | boolean | 0/1 | Threshold hit (up) |
| `has_down_hit` | boolean | 0/1 | Threshold hit (down) |
| `first_up_hit_minute` | number | 0-14 or NaN | First up hit minute |
| `first_down_hit_minute` | number | 0-14 or NaN | First down hit minute |
| `asset` | number | 0-3 | Asset encoding |
| `timestamp` | number | Unix ms | Feature computation time |

### Asset Encoding

| Asset | Encoding |
|-------|----------|
| BTC | 0 |
| ETH | 1 |
| SOL | 2 |
| XRP | 3 |

## Exporting from Argus

### Python Export Script

```python
#!/usr/bin/env python3
"""Export trained model to JSON format for Crypto15ML."""

import json
import numpy as np
from pathlib import Path
from sklearn.linear_model import LogisticRegression

def export_model(
    model: LogisticRegression,
    feature_columns: list[str],
    training_data: np.ndarray,
    asset: str,
    version: str,
    output_dir: Path
) -> None:
    """Export trained model to JSON format.

    Args:
        model: Trained sklearn LogisticRegression model
        feature_columns: List of feature names
        training_data: Training data for computing medians
        asset: Target asset symbol (e.g., 'BTCUSDT')
        version: Model version string
        output_dir: Output directory path
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Compute feature medians for imputation
    feature_medians = {}
    for i, col in enumerate(feature_columns):
        values = training_data[:, i]
        # Filter out NaN values for median calculation
        valid_values = values[~np.isnan(values)]
        if len(valid_values) > 0:
            feature_medians[col] = float(np.median(valid_values))
        else:
            feature_medians[col] = 0.0

    # Build model config
    model_config = {
        "version": version,
        "asset": asset,
        "featureColumns": feature_columns,
        "coefficients": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "featureMedians": feature_medians,
    }

    # Write model file
    model_path = output_dir / "crypto15ml_model.json"
    with open(model_path, "w") as f:
        json.dump(model_config, f, indent=2)
    print(f"Wrote: {model_path}")


def export_imputations(
    training_data: dict[str, np.ndarray],
    feature_columns: list[str],
    version: str,
    output_dir: Path
) -> None:
    """Export imputation values for all assets.

    Args:
        training_data: Dict of asset -> training data array
        feature_columns: List of feature names
        version: Version string
        output_dir: Output directory path
    """
    imputations = {}

    for asset, data in training_data.items():
        asset_imputations = {}
        for i, col in enumerate(feature_columns):
            values = data[:, i]
            valid_values = values[~np.isnan(values)]
            if len(valid_values) > 0:
                asset_imputations[col] = float(np.median(valid_values))
            else:
                asset_imputations[col] = 0.0
        imputations[asset] = asset_imputations

    output = {
        "version": version,
        "imputations": imputations,
    }

    output_path = output_dir / "crypto15ml_imputations.json"
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote: {output_path}")


# Example usage
if __name__ == "__main__":
    from argus.models import load_trained_model

    # Load your trained model
    model = load_trained_model("crypto15ml_v1")

    # Export
    export_model(
        model=model.sklearn_model,
        feature_columns=model.feature_columns,
        training_data=model.training_data,
        asset="BTCUSDT",
        version="1.0.0",
        output_dir=Path("./models")
    )
```

### Validation Script

After exporting, validate the files:

```python
#!/usr/bin/env python3
"""Validate exported model files."""

import json
from pathlib import Path

def validate_model(model_path: Path) -> list[str]:
    """Validate model JSON file.

    Returns list of validation errors (empty if valid).
    """
    errors = []

    with open(model_path) as f:
        config = json.load(f)

    # Check required fields
    required = ["version", "asset", "featureColumns", "coefficients",
                "intercept", "featureMedians"]
    for field in required:
        if field not in config:
            errors.append(f"Missing required field: {field}")

    # Check array lengths match
    if len(config.get("featureColumns", [])) != len(config.get("coefficients", [])):
        errors.append("featureColumns and coefficients length mismatch")

    # Check intercept is finite
    if not isinstance(config.get("intercept"), (int, float)):
        errors.append("intercept must be a number")

    # Check coefficients are all finite
    for i, coef in enumerate(config.get("coefficients", [])):
        if not isinstance(coef, (int, float)):
            errors.append(f"coefficient at index {i} is not a number")

    # Check feature medians
    for col in config.get("featureColumns", []):
        if col not in config.get("featureMedians", {}):
            errors.append(f"Missing median for feature: {col}")

    return errors

def validate_imputations(imputation_path: Path) -> list[str]:
    """Validate imputation JSON file."""
    errors = []

    with open(imputation_path) as f:
        config = json.load(f)

    if "imputations" not in config:
        errors.append("Missing 'imputations' field")
        return errors

    expected_assets = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]
    for asset in expected_assets:
        if asset not in config["imputations"]:
            errors.append(f"Missing imputations for asset: {asset}")

    return errors


if __name__ == "__main__":
    model_errors = validate_model(Path("./models/crypto15ml_model.json"))
    imputation_errors = validate_imputations(Path("./models/crypto15ml_imputations.json"))

    if model_errors:
        print("Model validation errors:")
        for err in model_errors:
            print(f"  - {err}")
    else:
        print("Model: OK")

    if imputation_errors:
        print("Imputation validation errors:")
        for err in imputation_errors:
            print(f"  - {err}")
    else:
        print("Imputations: OK")
```

## Deployment

### 1. Export Models

```bash
cd /path/to/argus
python scripts/export_crypto15ml.py --version 1.0.0 --output ./export
```

### 2. Copy to Hermes

```bash
cp export/crypto15ml_model.json /path/to/hermes/models/
cp export/crypto15ml_imputations.json /path/to/hermes/models/
```

### 3. Validate

```bash
cd /path/to/hermes
python scripts/validate_models.py
```

### 4. Test with Dry-Run

```bash
CRYPTO15ML_DRY_RUN=true pnpm run start
```

### 5. Deploy

```bash
git add models/
git commit -m "Update Crypto15ML models to v1.0.0"
git push
```

## Model Versioning

Recommended versioning scheme:

- **Major** (1.0.0 → 2.0.0): Breaking changes to feature set
- **Minor** (1.0.0 → 1.1.0): Model retrained with same features
- **Patch** (1.0.0 → 1.0.1): Bug fixes in export

Track model versions:

```json
{
  "version": "1.2.3",
  "trainedAt": "2026-01-10T00:00:00Z",
  "trainingDataRange": {
    "start": "2025-01-01",
    "end": "2025-12-31"
  },
  "metrics": {
    "accuracy": 0.62,
    "precision": 0.65,
    "recall": 0.58,
    "f1": 0.61
  }
}
```

## Troubleshooting

### Model Load Errors

**"Missing required field: X"**
- Ensure all required fields are in the JSON
- Check for typos in field names

**"featureColumns and coefficients length mismatch"**
- Verify export script outputs same number of columns and coefficients

**"Path must be within models/ directory"**
- Model paths are restricted for security
- Use relative paths within `models/` directory

### Inference Errors

**NaN predictions**
- Check for NaN values in feature medians
- Verify imputation file has all required features

**All predictions same value**
- Check if intercept is extreme (> 20 or < -20)
- Verify coefficients are not all zero
