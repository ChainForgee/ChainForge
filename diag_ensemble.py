"""Test an ensemble approach: OCR across multiple preprocessing variants per image."""
import sys
sys.path.insert(0, "app/ai-service")
import pytesseract
from PIL import Image
import numpy as np
import cv2

pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
from services.ocr import FieldDetector

fd = FieldDetector()

def numpy_to_image(a):
    if a.dtype != np.uint8: a = a.astype(np.uint8)
    return Image.fromarray(a)

def variants(arr):
    """Return list of (label, processed_image)."""
    out = []
    # raw grayscale
    out.append(("gray", numpy_to_image(arr)))
    # CLAHE + otsu
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    cla = clahe.apply(arr)
    _, th = cv2.threshold(cla, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    out.append(("clahe_otsu", numpy_to_image(th)))
    # upscale 2x + CLAHE + otsu
    h, w = arr.shape
    up = cv2.resize(arr, (w*2, h*2), interpolation=cv2.INTER_CUBIC)
    cla2 = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    upcla = cla2.apply(up)
    _, th2 = cv2.threshold(upcla, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    out.append(("2x_clahe_otsu", numpy_to_image(th2)))
    return out

base = "app/ai-service/regression_harness/dataset/degraded/documents/"
for name in ["sample_001_orig.png", "sample_001_rot90.png", "sample_001_rot180.png", "sample_001_rot270.png",
             "sample_001_lowc1.png", "sample_001_lowc2.png",
             "sample_001_blur2_lowc.png", "sample_001_blur4_lowc.png",
             "sample_001_lowres.png", "sample_001_lowres2.png",
             "sample_001_watermark30.png", "sample_001_watermark60.png"]:
    img = Image.open(base + name).convert("L")
    arr = np.array(img)
    h, w = arr.shape
    # rotations
    print(f"===== {name} (size {w}x{h}) =====")
    for angle in [0, 90, 180, 270]:
        if angle:
            rot = arr if angle == 0 else cv2.rotate(arr, {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[angle])
        else:
            rot = arr
        best = None
        for label, proc in variants(rot):
            text = pytesseract.image_to_string(proc, config="--psm 6 --oem 3")
            fields = fd.detect_fields(text)
            score = (len(fields), sum(f.confidence for f in fields.values()))
            if best is None or score > best[0]:
                best = (score, label, text, list(fields.keys()))
        print(f"  ang={angle}: best={best[0]} via {best[1]}: fields={best[3]}")
        print(f"    text={best[2][:120]!r}")
