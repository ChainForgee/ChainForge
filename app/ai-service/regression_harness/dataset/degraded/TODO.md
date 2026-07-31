# Degraded OCR Regression - Fix Summary

## Changes Made

### 1. Degraded Dataset
- Created `app/ai-service/regression_harness/dataset/degraded/ground_truth.json` - 12 samples
- Generated 12 degraded variants in `degraded/documents/`:
  - `sample_001_orig.png` - baseline
  - `sample_001_rot90/180/270.png` - rotated
  - `sample_001_lowc1/2.png` - low contrast
  - `sample_001_blur2/4_lowc.png` - blur + low contrast
  - `sample_001_lowres/lowres2.png` - low resolution
  - `sample_001_watermark30/60.png` - watermark overlay

### 2. Preprocessing Improvements (`preprocessing.py`)
- Added CLAHE contrast normalization before thresholding
- Added morphological closing (MORPH_CLOSE) for blur robustness

### 3. OCR Rotation Sweep (`ocr.py`)
- Added `_try_orientation()` method for evaluating OCR at any angle
- Orientation sweep across [0, 90, 180, 270] degrees
- Picks best candidate by (field_count, total_confidence)

### 4. CI Workflow
- Created `.github/workflows/ocr-regression-degraded.yml` - runs on pushes/PRs
- Enforces pass_ratio >= 0.9 and accuracy >= 60.0%

### 5. Test Fixes
- Fixed `test_ocr.py` mock assertion to expect >= 5 metric observations
- Fixed `conftest.py` to properly mock `cv2.createCLAHE` and `cv2.morphologyEx`

### 6. CLI Enhancement (`cli.py`)
- Added `--min_pass_ratio` flag for CI enforcement

## Remaining Issues to Fix

1. The standard OCR regression workflow (non-degraded) may time out due to 4x Tesseract calls per image - consider adding a cache or reducing sweep size for the default dataset
2. The `cv2` mock in `conftest.py` needs to return proper numpy arrays so preprocessor tests pass in CI

## CI Checks Status
- AI Service CI (build, docker-build, lint, security-scan, test) - ✅ all passing
- CI Python Tests - ❌ need to verify mock fixes work
- OCR Regression Test - ❌ need to verify standard dataset works with sweep
- OCR Regression Test (Degraded) - ❌ need to verify thresholds met
