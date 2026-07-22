import * as fs from 'fs';
import * as path from 'path';
import { ErrorCode, CONTRACT_ERROR_CODE_BY_NUMBER } from './codes';

/**
 * Reads `docs/errors.yaml` from the repo root and pulls every entry that
 * looks like `  - name: FOO` out of it. We deliberately do this without
 * a YAML dependency so the test remains cheap and dependency-free.
 */
function loadErrorNamesFromYaml(): Set<string> {
  const file = path.resolve(__dirname, '../../../../../docs/errors.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set<string>();
  const regex = /^\s*-\s*name:\s*([A-Z0-9_]+)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    names.add(match[1]);
  }
  return names;
}

describe('ErrorCode enum parity with docs/errors.yaml (Issue #249)', () => {
  const enumValues = new Set<string>(Object.values(ErrorCode));

  it('every ErrorCode enum value mirrors a `- name:` entry in docs/errors.yaml', () => {
    const yamlNames = loadErrorNamesFromYaml();
    expect(yamlNames.size).toBeGreaterThan(0);

    for (const value of enumValues) {
      expect(yamlNames.has(value)).toBe(true);
    }
  });

  it('every `- name:` entry in docs/errors.yaml is mirrored by ErrorCode', () => {
    const yamlNames = loadErrorNamesFromYaml();
    for (const name of yamlNames) {
      expect(enumValues.has(name)).toBe(true);
    }
  });

  it('every ErrorCode enum value is the exact string of its key', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it('CONTRACT_ERROR_CODE_BY_NUMBER covers all numeric slope variants 1..=23', () => {
    for (let i = 1; i <= 23; i++) {
      expect(CONTRACT_ERROR_CODE_BY_NUMBER[i]).toBeDefined();
      expect(Object.values(ErrorCode)).toContain(
        CONTRACT_ERROR_CODE_BY_NUMBER[i],
      );
    }
  });
});
