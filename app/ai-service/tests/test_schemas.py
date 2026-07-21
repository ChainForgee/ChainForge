import pytest
from schemas.ocr import OCRFieldResult, OCRData, OCRResponse


class TestOCRFieldResult:
    def test_valid_field_result(self):
        field = OCRFieldResult(value="John Doe", confidence=0.91)
        assert field.value == "John Doe"
        assert field.confidence == 0.91

    def test_confidence_bounds(self):
        field_low = OCRFieldResult(value="test", confidence=0.0)
        field_high = OCRFieldResult(value="test", confidence=1.0)
        assert field_low.confidence == 0.0
        assert field_high.confidence == 1.0

    def test_default_confidence(self):
        field = OCRFieldResult(value="John Doe")
        assert field.confidence == 0.0


class TestOCRData:
    def test_valid_ocr_data(self):
        fields = {
            "name": OCRFieldResult(value="John Doe", confidence=0.91),
            "date_of_birth": OCRFieldResult(value="1990-01-15", confidence=0.88),
            "id_number": OCRFieldResult(value="AB123456", confidence=0.90),
        }
        data = OCRData(fields=fields, raw_text="Name: John Doe", processing_time_ms=950)
        assert len(data.fields) == 3
        assert data.processing_time_ms == 950


class TestOCRResponse:
    def test_success_response(self):
        fields = {"name": OCRFieldResult(value="John Doe", confidence=0.91)}
        data = OCRData(fields=fields, raw_text="Name: John Doe", processing_time_ms=500)
        response = OCRResponse(success=True, data=data, processing_time_ms=500)
        assert response.success is True
        assert response.data is not None
        assert response.error is None

    def test_error_response(self):
        response = OCRResponse(
            success=False,
            error={"code": "invalid_image", "message": "Could not decode image"},
            processing_time_ms=100,
        )
        assert response.success is False
        assert response.data is None
        assert response.error is not None
        assert response.error["code"] == "invalid_image"

    def test_response_requires_success_field(self):
        response = OCRResponse(success=True, processing_time_ms=100)
        assert response.success is True

    def test_response_requires_processing_time(self):
        response = OCRResponse(success=True, processing_time_ms=100)
        assert response.processing_time_ms == 100


class TestErrorDetail:
    def test_valid_error_detail(self):
        error = {"code": "test_error", "message": "Test error message"}
        response = OCRResponse(success=False, error=error, processing_time_ms=0)
        assert response.error == error
        assert response.error["code"] == "test_error"


class TestSchemaModelVersionSnapshots:
    """Pins model_version in expected output schema snapshots."""

    def test_humanitarian_verification_response_snapshot(self):
        from schemas.humanitarian import HumanitarianVerificationResponse
        resp = HumanitarianVerificationResponse(
            success=True,
            provider="openai",
            model="gpt-4o-mini",
            prompt_variant="primary",
            verification={"verdict": "credible", "confidence": 0.95},
            model_version="gpt-4o-mini"
        )
        snapshot = resp.model_dump()
        assert snapshot["model_version"] == "gpt-4o-mini"
        assert snapshot["success"] is True
        assert snapshot["provider"] == "openai"

    def test_anonymize_response_snapshot(self):
        from schemas.anonymization import AnonymizeResponse, PIISummary
        resp = AnonymizeResponse(
            success=True,
            anonymized_text="Hello [RECIPIENT_NAME]",
            original_length=15,
            pii_summary=PIISummary(names=1, locations=0, dates=0, total=1),
            model_version="gpt-4o-mini"
        )
        snapshot = resp.model_dump()
        assert snapshot["model_version"] == "gpt-4o-mini"
        assert snapshot["success"] is True

    def test_ocr_response_snapshot(self):
        from schemas.ocr import OCRResponse, OCRData, OCRFieldResult
        resp = OCRResponse(
            success=True,
            data=OCRData(
                fields={"name": OCRFieldResult(value="John", confidence=0.9)},
                raw_text="Name: John",
                processing_time_ms=120
            ),
            processing_time_ms=120,
            model_version="gpt-4o-mini"
        )
        snapshot = resp.model_dump()
        assert snapshot["model_version"] == "gpt-4o-mini"
        assert snapshot["success"] is True

