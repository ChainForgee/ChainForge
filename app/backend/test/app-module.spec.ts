/**
 * Issue #256 — AppModule decomposition + duplicate-import guard.
 *
 * Located under ``app/backend/test/`` to match the acceptance
 * criterion that names this spec explicitly.  The spec guards three
 * invariants:
 *
 *  1. ``FEATURE_MODULES`` must not reference the same class twice.
 *  2. ``FeatureModuleRegistry.forRoot()`` produces a DynamicModule
 *     whose imports include every first-party feature exactly once.
 *  3. ``app.module.ts`` on disk stays below 80 lines and no longer
 *     hand-wires infrastructure modules like ``BullModule.forRootAsync``.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  FEATURE_MODULES,
  FEATURE_MODULE_NAMES,
  FeatureModuleRegistry,
} from '../src/feature-modules.registry';

describe('feature-modules.registry (Issue #256)', () => {
  it('contains no duplicate feature module class', () => {
    const seen = new Set<string>();
    for (const m of FEATURE_MODULES) {
      const name = m?.name ?? '<anonymous>';
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }
  });

  it('FEATURE_MODULE_NAMES matches FEATURE_MODULES contents', () => {
    expect(FEATURE_MODULE_NAMES.length).toBe(FEATURE_MODULES.length);
    expect(new Set(FEATURE_MODULE_NAMES).size).toBe(FEATURE_MODULE_NAMES.length);
  });

  it('FeatureModuleRegistry.forRoot() includes every feature module exactly once', () => {
    const dyn = FeatureModuleRegistry.forRoot();
    expect(dyn).toBeDefined();
    expect(Array.isArray(dyn.imports)).toBe(true);

    // Pull the actual class identity of every entry (works for raw
    // module classes and DynamicModule wrappers that include ``module``).
    const seen = new Set<string>();
    for (const entry of dyn.imports ?? []) {
      const cls = (entry as { module?: unknown }).module ?? entry;
      const name = (cls as { name?: string })?.name;
      expect(name).toBeDefined();
      expect(seen.has(name as string)).toBe(false);
      seen.add(name as string);
    }

    // Every module in FEATURE_MODULES must appear in the registry.
    for (const m of FEATURE_MODULES) {
      expect(seen.has(m?.name as string)).toBe(true);
    }
  });
});

describe('app.module.ts (Issue #256 - <80 LoC, single registry import)', () => {
  // This spec lives in ``app/backend/test/`` so ``__dirname`` is the
  // test directory and ``app.module.ts`` sits one level up at
  // ``../src/app.module.ts``.
  const appModulePath = path.join(__dirname, '..', 'src', 'app.module.ts');

  it('is strictly under 80 lines of code', () => {
    const text = fs.readFileSync(appModulePath, 'utf-8');
    const lines = text.split('\n');
    expect(lines.length).toBeLessThan(80);
  });

  it('imports the FeatureModuleRegistry so AppModule no longer wires modules by hand', () => {
    const text = fs.readFileSync(appModulePath, 'utf-8');
    expect(text).toMatch(/FeatureModuleRegistry/);
    // AppModule should no longer carry the inline infrastructure
    // factories — they were extracted into the registry.
    expect(text).not.toMatch(/BullModule\.forRootAsync/);
    expect(text).not.toMatch(/ThrottlerModule\.forRoot/);
    expect(text).not.toMatch(/RedisModule\.forRootAsync/);
    expect(text).not.toMatch(/ConfigModule\.forRoot/);
  });
});
