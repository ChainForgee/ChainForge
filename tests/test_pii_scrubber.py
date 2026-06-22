import json
import difflib
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
AI_SERVICE_DIR = ROOT_DIR / "app" / "ai-service"
sys.path.insert(0, str(AI_SERVICE_DIR))

from services.pii_scrubber import PIIScrubberService


def load_json(path):
    with open(path, "r") as f:
        return json.load(f)


inputs = load_json("tests/fixtures/pii_inputs.json")
expected = load_json("tests/fixtures/expected_outputs.json")


def test_pii_scrubbing():
    service = PIIScrubberService()

    for inp, exp in zip(inputs, expected):

        result = service.anonymize(inp["input"])["anonymized_text"]

        if result != exp["expected"]:

            diff = "\n".join(
                difflib.unified_diff(
                    [exp["expected"]],
                    [result],
                    fromfile="expected",
                    tofile="actual",
                    lineterm=""
                )
            )

            print("\nRegression Detected:")
            print(diff)

        assert result == exp["expected"]
