import re
import time
from dataclasses import dataclass, field
from typing import Dict

import pytesseract
from PIL import Image

import metrics
from config import settings
from services.preprocessing import ImagePreprocessor
from services.test_provider import TestProvider


@dataclass
class FieldMatch:
    value: str
    confidence: float


@dataclass
class OCRResult:
    fields: dict[str, FieldMatch]
    raw_text: str
    processing_time_ms: int


class FieldDetector:
    PATTERNS = {
        "name": [
            r"(?:Full\s+)?[Nn]ame[:\s]+\n?([A-Z][a-z]+(?:[ \t]+(?!(?i:Date|DOB|Birth|ID|Passport|Sex))\b[A-Z][a-z]+)*)",
            r"(?:Full\s+)?[Nn]ame[:\s]+\n?([A-Z]+(?:[ \t]+(?!(?i:DATE|DOB|BIRTH|ID|PASSPORT|SEX))\b[A-Z]+)*)",
        ],
        "date_of_birth": [
            r"[Dd]ate\s+(?:of\s+)?[Bb]irth[:\s]*(\d{2}[-./]\d{2}[-./]\d{4})",
            r"[Dd]ate\s+(?:of\s+)?[Bb]irth[:\s]*(\d{4}[-./]\d{2}[-./]\d{2})",
            r"[Dd][Oo][Bb][:?\s]*(\d{2}[-./]\d{2}[-./]\d{4})",
            r"[Dd][Oo][Bb][:?\s]*(\d{4}[-./]\d{2}[-./]\d{2})",
            r"[Bb]irth\s*[Dd]ate[:\s]*(\d{2}[-./]\d{2}[-./]\d{4})",
            r"[Dd]ate\s+(?:of\s+)?[Bb]irth[:\s\n]*(\d{1,2}\s+[A-Za-z]+\s+\d{4})",
            r"[Dd][Oo][Bb][:?\s\n]*(\d{1,2}\s+[A-Za-z]+\s+\d{4})",
            r"(\d{1,2}\s+[A-Za-z]+\s+\d{4})",
        ],
        "id_number": [
            r"[Ii][Dd]\s+[Nn]umber[:\s]+([A-Z0-9]{6,12})\b",
            r"[Ii][Dd][:\s]+([A-Z0-9]{6,12})\b",
            r"[Ii][Dd](?:entification)?[:\s]+([A-Z0-9]{6,12})\b",
            r"[Pp]assport\s*[Nn]o[:\s]+([A-Z0-9]{6,12})\b",
            r"[Nn][Ii][Dd][:\s]+([A-Z0-9]{6,12})\b",
        ],
    }

    def detect_fields(self, text: str) -> dict[str, FieldMatch]:
        if not isinstance(text, str):
            text = str(text) if text else ""
        text = text.strip()
        if not text:
            return {}

        fields = {}

        for field_name, patterns in self.PATTERNS.items():
            for pattern in patterns:
                match = re.search(pattern, text, re.IGNORECASE)
                if match:
                    fields[field_name] = FieldMatch(
                        value=match.group(1).strip(),
                        confidence=0.8,
                    )
                    break

        return fields

    def aggregate_confidence(self, char_confidences: list[float]) -> float:
        if not char_confidences:
            return 0.0
        return sum(char_confidences) / len(char_confidences)


class OCRService:
    def __init__(self):
        self.preprocessor = ImagePreprocessor()
        self.field_detector = FieldDetector()
        self.test_provider = TestProvider()

    def _try_orientation(self, image: Image.Image, angle: int):
        """Run OCR on an image rotated by `angle` degrees.

        Returns (num_fields, total_conf, OCRResult) for the best preprocessing
        variant. We evaluate several preprocessing strategies for robustness
        against rotation, low contrast, blur, and low resolution:
          - raw grayscale (often best for already-clean / slightly degraded input)
          - CLAHE contrast-normalized + Otsu (best for low-contrast input)
          - 2x upscaled + CLAHE + Otsu (helps low-resolution input)
        The candidate that yields the most detected fields (then highest
        aggregated confidence) is returned.

        Page-segmentation modes 6 (uniform block) and 11 (sparse text) are both
        attempted because they complement each other on degraded documents:
        11 recovers low-resolution text that 6 often misses, while 6 usually
        parses well-formed blocks cleanly.
        """
        rotated = image.rotate(angle, expand=True) if angle else image

        # Raw grayscale (no CLAHE / thresholding) often preserves low-resolution
        # text better than a binarised image, so evaluate it as its own pass.
        raw_gray = rotated.convert("L") if rotated.mode != "L" else rotated

        candidates = [
            ("gray", self.preprocessor.preprocess(
                rotated, threshold_method="otsu", denoise=False
            )),
            ("clahe", self.preprocessor.preprocess(
                rotated, threshold_method="otsu", denoise=True
            )),
            ("raw_gray", raw_gray),
        ]
        # Add an upscaled candidate to help low-resolution images.
        upscaled = self._upscale(rotated)
        if upscaled is not None:
            candidates.append(
                ("upscale_clahe", self.preprocessor.preprocess(
                    upscaled, threshold_method="otsu", denoise=True
                ))
            )

        best = None
        for _label, preprocessed in candidates:
            if preprocessed.size[0] == 0 or preprocessed.size[1] == 0:
                continue

            for psm in (6, 11, 12):
                tesseract_data = self._run_tesseract(preprocessed, psm=psm)

                raw_text = tesseract_data.get("text", "")
                if isinstance(raw_text, list):
                    raw_text = " ".join(str(t) for t in raw_text if t)
                raw_text = str(raw_text) if raw_text else ""

                fields = self.field_detector.detect_fields(raw_text)

                total_conf = 0.0
                for field_name, field_match in fields.items():
                    field_chars = self._extract_field_chars(
                        tesseract_data, field_match.value
                    )
                    field_match.confidence = self.field_detector.aggregate_confidence(
                        field_chars
                    )
                    total_conf += field_match.confidence

                ocr_result = OCRResult(
                    fields=fields,
                    raw_text=raw_text,
                    processing_time_ms=0,
                )

                score = (len(fields), total_conf)
                if best is None or score > best[0]:
                    best = (score, ocr_result)

        if best is None:
            return None
        return (best[0][0], best[0][1], best[1])

    @staticmethod
    def _upscale(image: Image.Image):
        """Return a 2x upscaled copy of the image (or None if it is empty)."""
        if image.size[0] == 0 or image.size[1] == 0:
            return None
        return image.resize((image.size[0] * 2, image.size[1] * 2), Image.LANCZOS)

    def process_image(self, image: Image.Image) -> OCRResult:
        if settings.test_provider_mode:
            response = self.test_provider.get_response("ocr", {"image_size": str(image.size)})
            fields: Dict[str, FieldMatch] = {}
            for name, fdata in response.get("fields", {}).items():
                fields[name] = FieldMatch(value=fdata["value"], confidence=fdata["confidence"])
            return OCRResult(
                fields=fields,
                raw_text=response.get("raw_text", ""),
                processing_time_ms=response.get("processing_time_ms", 0),
            )

        start_time = time.time()

        # Robustness for rotated / degraded images:
        # Try multiple orientations and pick the candidate with the highest
        # number of detected fields (then confidence).
        candidates = [0, 90, 180, 270]
        best = None  # (score_fields, score_conf, OCRResult)

        for ang in candidates:
            result = self._try_orientation(image, ang)
            if result is None:
                continue

            score_fields, score_conf, ocr_result = result

            if best is None:
                best = (score_fields, score_conf, ocr_result)
            else:
                # Prefer more fields; tie-break by confidence
                if (score_fields, score_conf) > (best[0], best[1]):
                    best = (score_fields, score_conf, ocr_result)

        if best is None:
            return OCRResult(
                fields={},
                raw_text="",
                processing_time_ms=int((time.time() - start_time) * 1000),
            )

        latency = time.time() - start_time
        metrics.PIPELINE_STEP_LATENCY.labels(step_name='ocr').observe(latency)

        best_fields = best[2].fields
        best_raw_text = best[2].raw_text

        return OCRResult(
            fields=best_fields,
            raw_text=best_raw_text,
            processing_time_ms=int(latency * 1000),
        )

    def _run_tesseract(self, image: Image.Image, psm: int = 6) -> dict:
        config = f"--psm {psm} --oem 3"
        data = pytesseract.image_to_data(
            image, config=config, output_type=pytesseract.Output.DICT
        )
        return data

    def _extract_field_chars(
        self, tesseract_data: dict, field_value: str
    ) -> list[float]:
        confidences = []
        texts = tesseract_data.get("text", [])
        confs = tesseract_data.get("conf", [])

        if isinstance(texts, str):
            texts = [texts]
        if isinstance(confs, (int, float)):
            confs = [confs]

        for i, text in enumerate(texts):
            if field_value.lower() in str(text).lower():
                if i < len(confs):
                    try:
                        conf = float(confs[i])
                        if conf > 0:
                            confidences.append(conf / 100.0)
                    except (ValueError, TypeError):
                        pass

        return confidences if confidences else [0.8]
