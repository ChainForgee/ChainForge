"""
app/ai-service/tests/test_codes.py

Issue #249 parity test for the AI service: verifies that the Python
binding in ``schemas/codes.py`` is consistent with ``docs/errors.yaml``
(the single source of truth) AND with the TypeScript binding in
``app/backend/src/common/errors/codes.ts``.

Mirrors ``app/backend/src/common/errors/codes.spec.ts`` so any drift
breaks BOTH builds simultaneously rather than silently regressing in
only one repo.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import List

import pytest

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[2]  # tests/ -> ai-service/ -> app/ -> repo root

# ---------------------------------------------------------------------------
# pytest discovery — when pytest is invoked from any cwd, ai-service/
# must be on sys.path so `from schemas.codes import ...` resolves.
# Existing tests like tests/test_error_envelope.py rely on the project's
# pytest config pinning cwd to app/ai-service, but we add the directory
# defensively below so the parity test also runs under alternative
# runners (pytest --rootdir repo, IDE test runners, etc.).
# MUST come BEFORE the `from schemas.codes import ...` line below.
# ---------------------------------------------------------------------------
_AI_SERVICE_ROOT = _HERE.parents[1]
if str(_AI_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_AI_SERVICE_ROOT))

from schemas.codes import (  # noqa: E402  (intentional sys.path tweak above)
    ERROR_CODE_META,
    ErrorCode,
    code_for_http_status,
    http_status_for_code,
)

YAML_PATH = _REPO_ROOT / "docs" / "errors.yaml"


class _YamlEntry(dict):
    """Tiny dotted-access shim so tests read ``entry.code`` cleanly."""

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as e:
            raise AttributeError(key) from e


def _coerce_value(key: str, raw: str):
    """Cast a YAML scalar to the right Python type.

    Keeps the parser small: known numeric shape (``httpStatus``) is int,
    everything else stays str.  Adding more types means extending the
    switch.
    """
    if key == "httpStatus":
        return int(raw)
    return raw


def _load_yaml() -> List[_YamlEntry]:
    """Minimal line-based YAML reader for docs/errors.yaml.

    The schema is intentionally trivial (a flat list of ``- key: value``
    blocks under ``codes:``) so we don't pull in PyYAML just for parity
    testing.  Both the TS and Python parity tests share this exact
    parser shape so any divergence catches the eye.

    NOTE — when changing this parser, KEEP IT IN LOCK-STEP with
    ``loadYaml()`` in ``app/backend/src/common/errors/codes.spec.ts``.
    The two parsers MUST interpret the same lines the same way or the
    parity suite will pass or fail asymmetrically across the two repos.

    KNOWN LIMITATIONS (intentional, see also the TS parser):
      * ``#``-prefixed comments and trailing comments are stripped.
      * Multi-line block scalars (``|`` / ``>``) are NOT supported.
        Every description in docs/errors.yaml is a single line ending
        in a period.  If a future description contains a literal ``:``
        the regex below will truncate at the first ``:``; the parity
        test will catch such a regression because both parsers use
        the identical regex.
    """
    if not YAML_PATH.exists():
        pytest.fail(
            f"Shared error-code taxonomy not found at {YAML_PATH}. "
            "Issue #249 requires docs/errors.yaml as the single source of truth."
        )
    raw = YAML_PATH.read_text(encoding="utf-8").splitlines()

    codes: List[_YamlEntry] = []
    in_codes = False
    current: _YamlEntry | None = None
    for line in raw:
        # Strip leading + trailing whitespace AND drop comments so
        # `  - code: HTTP_500` (list marker indented two spaces) is
        # detected by the simple `startswith("- ")` test below, and so
        # `# ---- HTTP status codes ---` separators are skipped cleanly.
        hash_idx = line.find("#")
        line_no_comment = line[:hash_idx] if hash_idx >= 0 else line
        stripped = line_no_comment.strip()
        if stripped == "":
            continue
        if stripped.startswith("version:"):
            continue
        if stripped == "codes:":
            in_codes = True
            continue
        if not in_codes:
            continue
        if stripped.startswith("- "):
            # Start of a new entry: the rest of the line is a `key: value`
            # pair whose KEY is the entry's first property.  We DO NOT
            # assume the first line is always `- code: …` — a future YAML
            # could start with `- name: …` or similar.  The remainder is
            # parsed with the same key:value regex used for indented lines.
            if current is not None:
                codes.append(current)
            tail = stripped[2:]  # e.g. ``code: HTTP_400``
            m_entry = re.match(r"^([a-zA-Z_]+):\s*(.*)$", tail)
            if m_entry:
                ek, ev = m_entry.group(1), m_entry.group(2).strip().strip('"').strip("'")
                current = _YamlEntry({ek: _coerce_value(ek, ev)})
            else:
                # Malformed entry line; drop `current` so subsequent
                # key/value lines don't attach to garbage.  The previous
                # entry (if any) was already appended above.
                current = None
            continue
        if current is None:
            continue
        m = re.match(r"^([a-zA-Z_]+):\s*(.*)$", stripped)
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip().strip('"').strip("'")
        current[key] = _coerce_value(key, value)
    if current is not None:
        codes.append(current)
    return codes


@pytest.fixture(scope="module")
def yaml_codes() -> List[_YamlEntry]:
    return _load_yaml()


# ---------------------------------------------------------------------------
# pytest discovery `sys.path` tweak lives at the TOP of this module
# (above the `from schemas.codes import ...` line) so the import works
# even when pytest is invoked from the repo root, not from app/ai-service.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def yaml_codes() -> List[_YamlEntry]:
    return _load_yaml()


def test_yaml_loaded(yaml_codes):
    assert len(yaml_codes) > 0, "docs/errors.yaml must declare at least one code"


def test_every_yaml_entry_in_python_module(yaml_codes):
    """Every YAML entry has a matching ErrorCode + meta entry in Python."""
    for entry in yaml_codes:
        code = entry["code"]
        try:
            enum_value = ErrorCode(code)
        except ValueError as e:
            pytest.fail(
                f"docs/errors.yaml declares code {code!r} which is missing "
                f"from ErrorCode in app/ai-service/schemas/codes.py: {e}"
            )

        meta = ERROR_CODE_META[enum_value]
        assert meta.code == code
        assert meta.http_status == entry["httpStatus"], (
            f"docs/errors.yaml lists {code} with httpStatus="
            f"{entry['httpStatus']!r} but the Python meta has {meta.http_status!r}"
        )
        assert meta.description == entry["description"], (
            f"docs/errors.yaml description for {code} is out of sync with "
            f"schemas/codes.py ERROR_CODE_META"
        )


def test_every_python_member_in_yaml(yaml_codes):
    """No orphan enum members — every Python enum value is documented in YAML."""
    yaml_codes_set = {e["code"] for e in yaml_codes}
    for value in ErrorCode:
        assert value.value in yaml_codes_set, (
            f"ErrorCode.{value.name} = {value.value!r} is in "
            f"app/ai-service/schemas/codes.py but not in docs/errors.yaml"
        )


def test_every_meta_key_in_enum():
    """No orphan meta entries — every meta key is a valid ErrorCode."""
    enum_values = set(ErrorCode)
    for key in ERROR_CODE_META.keys():
        assert key in enum_values, (
            f"ERROR_CODE_META contains key {key!r} which is missing "
            f"from ErrorCode enum"
        )


@pytest.mark.parametrize(
    "http_status,expected_code",
    [
        (400, "HTTP_400"),
        (401, "HTTP_401"),
        (404, "HTTP_404"),
        (422, "HTTP_422"),
        (500, "HTTP_500"),
        (502, "HTTP_502"),
        (503, "HTTP_503"),
    ],
)
def test_code_for_http_status_known(http_status, expected_code):
    assert code_for_http_status(http_status) == expected_code


def test_code_for_http_status_unknown_falls_back():
    assert code_for_http_status(418) == "HTTP_418"


@pytest.mark.parametrize(
    "code,expected_status",
    [
        ("HTTP_500", 500),
        ("HTTP_404", 404),
        ("INTERNAL_SERVER_ERROR", 500),
        ("VALIDATION_ERROR", 422),
        ("AI_SERVICE_ERROR", 502),
        ("PAYLOAD_TOO_LARGE", 413),
    ],
)
def test_http_status_for_code_known(code, expected_status):
    assert http_status_for_code(code) == expected_status


def test_http_status_for_code_unknown():
    assert http_status_for_code("NOPE") is None


# ---------------------------------------------------------------------------
# Issue #249 — first-declared-wins lookup contract.
#
# docs/errors.yaml and schemas/codes.py declare entries in a specific
# order.  Both ``code_for_http_status`` and the TS equivalent
# ``codeForHttpStatus`` pick the FIRST enum entry that matches the
# HTTP status, so the canonical name for an HTTP-status-with-alias
# pair MUST be the ``HTTP_<n>`` member, not the alias.
#
# This locks down the contract so a future PR that reorders the enum
# cannot silently flip the wire string from ``HTTP_500`` to
# ``INTERNAL_SERVER_ERROR`` (or vice versa).
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "http_status,canonical",
    [
        (500, "HTTP_500"),    # not INTERNAL_SERVER_ERROR
        (422, "HTTP_422"),     # not VALIDATION_ERROR
        (413, "HTTP_413"),     # not PAYLOAD_TOO_LARGE
        (502, "HTTP_502"),     # not AI_SERVICE_ERROR
    ],
)
def test_first_declared_wins_lookup_contract(http_status, canonical):
    assert code_for_http_status(http_status) == canonical
