"""Diagnose the ACTUAL preprocessing pipeline on each degraded image."""
import sys
sys.path.insert(0, "app/ai-service")
import pytesseract
from PIL import Image
import numpy as np

pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

from services.preprocessing import ImagePreprocessor

pp = ImagePreprocessor()
base = "app/ai-service/regression_harness/dataset/degraded/documents/"

for name in ["sample_001_orig.png", "sample_001_lowc1.png", "sample_001_lowc2.png",
             "sample_001_lowres.png", "sample_001_lowres2.png"]:
    img = Image.open(base + name)
    proc = pp.preprocess(img, threshold_method="otsu", denoise=True)
    text = pytesseract.image_to_string(proc, config="--psm 6 --oem 3")
    print(f"===== {name} =====")
    print(repr(text))

# Also try WITHOUT denoise
print("\n\n--- WITHOUT DENOISE ---")
for name in ["sample_001_lowc2.png", "sample_001_lowres.png", "sample_001_lowres2.png"]:
    img = Image.open(base + name)
    proc = pp.preprocess(img, threshold_method="otsu", denoise=False)
    text = pytesseract.image_to_string(proc, config="--psm 6 --oem 3")
    print(f"===== {name} (denoise=False) =====")
    print(repr(text))
