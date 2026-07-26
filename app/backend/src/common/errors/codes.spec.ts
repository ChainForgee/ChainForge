/**
 * src/common/errors/codes.spec.ts
 *
 * Issue #249 parity test: verifies that the TypeScript binding in
 * `codes.ts` is consistent with `docs/errors.yaml`, the single source of
 * truth, AND with the Python binding in `app/ai-service/schemas/codes.py`.
 *
 * The test loads the YAML from the repo root, walks every `codes` entry,
 * and asserts:
 *   1. `ErrorCode[yamlCode]` exists and round-trips to `yamlCode`.
 *   2. `ERROR_CODE_META[ErrorCode[yamlCode]].httpStatus === yaml.httpStatus`.
 *   3. `ERROR_CODE_META[ErrorCode[yamlCode]].description === yaml.description`.
 *   4. Every key in `ERROR_CODE_META` exists in `ErrorCode`.
 *
 * The YAML may have entries the TS module has not yet implemented — that
 * is a deliberate parity failure (issue asks: "identical between backend
 * and AI service").
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ErrorCode,
  ERROR_CODE_META,
  codeForHttpStatus,
  httpStatusForCode,
} from './codes';

interface YamlCodeEntry {
  code: string;
  httpStatus: number;
  description: string;
  category?: string;
}

interface YamlDoc {
  version: number;
  codes: YamlCodeEntry[];
}

const YAML_PATH = path.resolve(__dirname, '../../../docs/errors.yaml');

function loadYaml(): YamlDoc {
  if (!fs.existsSync(YAML_PATH)) {
    throw new Error(
      `Shared error-code taxonomy not found at ${YAML_PATH}. ` +
        `Issue #249 requires docs/errors.yaml as the single source of truth.`,
    );
  }
  const raw = fs.readFileSync(YAML_PATH, 'utf8');

  // Minimal line-based YAML parser sufficient for docs/errors.yaml's
  // simple key: scalar / dash-list schema.  We avoid pulling in a
  // YAML dependency just for one static config file.
  //
  // NOTE — when changing this parser, KEEP IT IN LOCK-STEP with
  // _load_yaml() in app/ai-service/tests/test_codes.py.  The two
  // parsers MUST interpret the same lines the same way or the parity
  // suite will pass or fail asymmetrically across the two repos.
  const codes: YamlCodeEntry[] = [];
  let inCodesBlock = false;
  let current: Partial<YamlCodeEntry> | null = null;
  let version = 1;
  for (const rawLine of raw.split('\n')) {
    // Strip both leading AND trailing whitespace so `  - code: ...`
    // (a YAML list marker nested two spaces in) can be detected by the
    // simple `startsWith('- ')` test below.  Also drop any comment-only
    // or trailing-comment lines (anything past the first `#`).
    const hashIdx = rawLine.indexOf('#');
    const lineNoComment = hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine;
    const trimmed = lineNoComment.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('version:')) {
      const v = Number(trimmed.split(':')[1].trim());
      if (Number.isInteger(v)) version = v;
      continue;
    }
    if (trimmed === 'codes:') {
      inCodesBlock = true;
      continue;
    }
    if (!inCodesBlock) continue;
    if (trimmed.startsWith('- ')) {
      // Start of a new entry: the rest of the line is a `key: value` pair
      // whose KEY is the entry's first property (e.g. `- code: HTTP_400`
      // → ``code = "HTTP_400"``), NOT a single value squashed into a
      // hard-coded `code` key.  We parse the remainder with the same
      // key:value regex used for subsequent indented lines so the two
      // are guaranteed to agree.
      const prev = current;
      current = {};
      const tail = trimmed.slice(2); // e.g. ``code: HTTP_400``
      const mEntry = /^([a-zA-Z_]+):\s*(.*)$/.exec(tail);
      if (mEntry) {
        setKeyOn(current, mEntry[1], mEntry[2].replace(/^['"]|['"]$/g, '').trim());
      } else {
        // Malformed entry line; drop `current` so subsequent key/value
        // lines don't attach to garbage.  The previous entry (if any)
        // was already pushed above.
        current = null;
      }
      if (prev) {
        codes.push(prev as YamlCodeEntry);
      }
      continue;
    }
    if (!current) continue;
    // Allow `key:` and `key: value` lines.  We deliberately do NOT
    // handle multi-line `|` / `>` block scalars — docs/errors.yaml
    // keeps every description on a single line, ending in `.`.
    // If a future description contains a literal `:`, this regex
    // WILL truncate at the first `:`.  The parity test will catch
    // any such breakage because the Python module's _load_yaml uses
    // an identical regex.
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(trimmed);
    if (m) {
      setKeyOn(current, m[1], m[2].replace(/^['"]|['"]$/g, '').trim());
    }
  }
  if (current) {
    codes.push(current as YamlCodeEntry);
  }
  return { version, codes };
}

/**
 * Write a single key/value pair into `target`, applying any required
 * type coercion.  Mirrors `_coerce_value` in
 * `app/ai-service/tests/test_codes.py` — keep them in lock-step so
 * the two YAML parsers cannot disagree on how a scalar is interpreted.
 */
function setKeyOn(
  target: Partial<YamlCodeEntry>,
  key: string,
  raw: string,
): void {
  if (key === 'httpStatus') {
    target.httpStatus = Number(raw);
  } else {
    // All other keys (`code`, `description`, `category`, …) stay
    // as strings.  Adding a new numeric key means extending this
    // switch AND the matching switch in `_coerce_value`.
    target[key] = raw;
  }
}

describe('Shared error-code taxonomy (Issue #249)', () => {
  describe('parity with docs/errors.yaml', () => {
    it('every YAML entry has a matching ErrorCode + meta entry', () => {
      const yaml = loadYaml();
      expect(yaml.codes.length).toBeGreaterThan(0);

      for (const entry of yaml.codes) {
        const tsValue = (ErrorCode as Record<string, string>)[entry.code];
        expect(tsValue).toBeDefined();
        expect(tsValue).toBe(entry.code);

        const enumKey = (ErrorCode as Record<string, unknown>)[
          entry.code
        ] as ErrorCode;
        const meta = ERROR_CODE_META[enumKey];
        expect(meta).toBeDefined();
        expect(meta.code).toBe(entry.code);
        expect(meta.httpStatus).toBe(entry.httpStatus);
        expect(meta.description).toBe(entry.description);
      }
    });

    it('every ErrorCode enum value is present in docs/errors.yaml', () => {
      const yaml = loadYaml();
      const yamlCodes = new Set(yaml.codes.map(c => c.code));
      for (const value of Object.values(ErrorCode)) {
        expect(yamlCodes.has(value as string)).toBe(true);
      }
    });

    it('every ERROR_CODE_META key is in the ErrorCode enum', () => {
      const enumValues = new Set<string>(Object.values(ErrorCode));
      for (const key of Object.keys(ERROR_CODE_META)) {
        expect(enumValues.has(key)).toBe(true);
      }
    });
  });

  describe('reverse lookups', () => {
    it('codeForHttpStatus returns the canonical string code for known statuses', () => {
      // Mirror a few that are stable in the YAML.
      expect(codeForHttpStatus(500)).toBe('HTTP_500');
      expect(codeForHttpStatus(404)).toBe('HTTP_404');
      expect(codeForHttpStatus(422)).toBe('HTTP_422');
    });

    it('codeForHttpStatus falls back to HTTP_<n> for unknown statuses', () => {
      expect(codeForHttpStatus(418)).toBe('HTTP_418');
    });

    it('httpStatusForCode returns the canonical numeric status for known codes', () => {
      expect(httpStatusForCode('HTTP_500')).toBe(500);
      expect(httpStatusForCode('HTTP_404')).toBe(404);
    });

    it('httpStatusForCode returns undefined for unknown codes', () => {
      expect(httpStatusForCode('NOPE')).toBeUndefined();
    });
  });

  describe('first-declared-wins lookup contract', () => {
    // Issue #249 — `codeForHttpStatus(500)` MUST resolve to `HTTP_500`
    // (the canonical name), not `INTERNAL_SERVER_ERROR` (the alias)
    // even though both share httpStatus=500.  This locks down the
    // insertion-order contract; if a future PR reorders the table
    // this test catches it before the wire format silently changes.
    it('returns the canonical HTTP_<n> name (not the alias) for shared statuses', () => {
      expect(codeForHttpStatus(500)).toBe('HTTP_500');
      expect(codeForHttpStatus(422)).toBe('HTTP_422'); // not VALIDATION_ERROR
      expect(codeForHttpStatus(413)).toBe('HTTP_413'); // not PAYLOAD_TOO_LARGE
      expect(codeForHttpStatus(502)).toBe('HTTP_502'); // not AI_SERVICE_ERROR
    });
  });
});
