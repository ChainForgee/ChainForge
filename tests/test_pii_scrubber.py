import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROOT_SCRUBBER = ROOT / "scrubber.py"
AI_SERVICE_SCRUBBER = ROOT / "app" / "ai-service" / "services" / "pii_scrubber.py"


def _function_names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}


def _class_method_names(path: Path, class_name: str) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return {
                child.name
                for child in node.body
                if isinstance(child, ast.FunctionDef)
            }
    return set()


def test_root_scrubber_no_longer_exports_legacy_scrub_function():
    assert "scrub_pii" not in _function_names(ROOT_SCRUBBER)


def test_ai_service_pii_scrubber_is_canonical_implementation():
    methods = _class_method_names(AI_SERVICE_SCRUBBER, "PIIScrubberService")

    assert "anonymize" in methods
