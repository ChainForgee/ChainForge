/**
 * Issue #256 — AppModule decomposition + duplicate-import guard.
 *
 * Located under ``app/backend/test/`` to match the acceptance
 * criterion that names this spec explicitly.  The spec guards three
 * invariants:
 *
 *  1. ``FEATURE_MODULES`` must not reference the same class twice.
 *  2. ``FeatureModuleRegistry.forRoot()`` is a DynamicModule whose
 *     imports array contains the entire feature module list (the
 *     cross-cutting infrastructure ``forRoot(...)`` factories run
 *     exactly once each because they are singletons by design).
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

/**
 * Coerce an arbitrary import-entry shape used by NestJS dynamic module
 * factories into a stable string identity.  Handles:
 *   - raw module classes (function with ``.name``)
 *   - ``DynamicModule`` wrappers (``entry.module.name``)
 *
 * Infrastructure factories such as ``RedisModule.forRootAsync(...)``
 * return wrappers whose shape differs slightly across NestJS
 * packages, so this helper is deliberately tolerant: if we cannot
 * name an entry, it is treated as an opaque infrastructure singleton
 * and does not participate in the duplicate guard.
 */
function entryName(entry: unknown): string | undefined {
  if (typeof entry === 'function') {
    return (entry as { name?: string }).name;
  }
  if (entry && typeof entry === 'object') {
    const mod = (entry as { module?: { name?: string } }).module;
    if (mod && typeof mod === 'object' && 'name' in mod) {
      return mod.name;
    }
  }
  return undefined;
}

describe('feature-modules.registry (Issue #256)', () => {
  it('contains no duplicate feature module class', () => {
    // The acceptance criterion for #256 is "no feature module is
    // imported twice".  The duplicate guard focuses on the
    // first-party ``FEATURE_MODULES`` list because that is where a
    // double-registration matters.  Infrastructure ``forRoot(...)``
    // factories return DynamicModule wrappers and are designed to be
    // singletons.
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

  it('FeatureModuleRegistry.forRoot() returns a DynamicModule with imports', () => {
    const dyn = FeatureModuleRegistry.forRoot();
    expect(dyn).toBeDefined();
    expect(Array.isArray(dyn.imports)).toBe(true);
    expect((dyn.imports ?? []).length).toBeGreaterThan(0);
  });

  it('FeatureModuleRegistry.forRoot() includes every FEATURE_MODULE entry without duplication', () => {
    const dyn = FeatureModuleRegistry.forRoot();

    // Collect the named entries we can recognise.  Anything we can't
    // name (e.g. an opportunistic DynamicModule wrapper missing a
    // ``module`` reference) doesn't participate in the duplicate
    // guard — those are infrastructure-side singletons.
    const seen = new Set<string>();
    for (const entry of dyn.imports ?? []) {
      const name = entryName(entry);
      if (name === undefined) {
        continue;
      }
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }

    for (const m of FEATURE_MODULES) {
      const name = m?.name;
      expect(name).toBeDefined();
      expect(seen.has(name as string)).toBe(true);
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
