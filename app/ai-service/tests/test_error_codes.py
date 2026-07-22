"""Parity test for cross-service error codes (Issue #249).

Asserts that:

* every member of ``ErrorCode`` has a matching ``- name:`` entry in
  ``docs/errors.yaml``,
* every ``- name:`` entry in ``docs/errors.yaml`` has a matching
  ``ErrorCode`` member,
* the numeric Soroban mapping covers variants 1..=23.
"""
from __future__ import annotations

import re
from pathlib import Path

from schemas.error_codes import (
    CONTRACT_ERROR_CODE_BY_NUMBER,
    ErrorCode,
    error_code_for_http_status,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
YAML_PATH = REPO_ROOT / "docs" / "errors.yaml"


def load_yaml_error_names() -> set[str]:
    text = YAML_PATH.read_text(encoding="utf-8")
    return set(re.findall(r"^\s*-\s*name:\s*([A-Z0-9_]+)\s*$", text, flags=re.MULTILINE))


class TestErrorCodeParity:
    def test_python_enum_mirrors_yaml(self):
        yaml_names = load_yaml_error_names()
        assert yaml_names, f"docs/errors.yaml had no `- name:` entries at {YAML_PATH}"

        enum_values = {member.value for member in ErrorCode}

        missing_from_enum = yaml_names - enum_values
        extra_in_enum = enum_values - yaml_names

        assert not missing_from_enum, (
            f"docs/errors.yaml lists codes missing from Python ErrorCode: "
            f"{sorted(missing_from_enum)}"
        )
        assert not extra_in_enum, (
            f"Python ErrorCode has names not in docs/errors.yaml: "
            f"{sorted(extra_in_enum)}"
        )

    def test_enum_value_matches_member_name(self):
        for member in ErrorCode:
            assert member.value == member.name, (
                f"{member.name} serialises to {member.value!r} (expected {member.name!r})"
            )

    def test_contract_numeric_table_covers_all_23_variants(self):
        for code in range(1, 24):
            assert code in CONTRACT_ERROR_CODE_BY_NUMBER, (
                f"Soroban error code {code} is missing from CONTRACT_ERROR_CODE_BY_NUMBER"
            )
            table_value = CONTRACT_ERROR_CODE_BY_NUMBER[code]
            # Must be a real ErrorCode member (no sentinel/None)
            assert isinstance(table_value, ErrorCode)

    def test_http_status_map_is_well_formed(self):
        # Re-maps a representative subset of HTTP statuses that the
        # FastAPI app raises today.
        assert error_code_for_http_status(401) == ErrorCode.UNAUTHORIZED
        assert error_code_for_http_status(404) == ErrorCode.NOT_FOUND
        assert error_code_for_http_status(413) == ErrorCode.PAYLOAD_TOO_LARGE
        assert error_code_for_http_status(422) == ErrorCode.VALIDATION_ERROR
        assert error_code_for_http_status(502) == ErrorCode.UPSTREAM_ERROR
        assert error_code_for_http_status(504) == ErrorCode.UPSTREAM_TIMEOUT
        # Unknown codes fall into the safest bucket, never a new name.
        assert error_code_for_http_status(418) == ErrorCode.BAD_REQUEST
        assert error_code_for_http_status(599) == ErrorCode.UPSTREAM_ERROR
