/**
 * Global Jest setup that registers jest-axe accessibility matchers so they
 * are available in any *.a11y.test.* file across the project.
 *
 * The matchers are loaded lazily because jest-axe expects to be invoked from
 * inside the Jest test environment (jsdom). Tests that exercise this setup
 * are expected to opt into the jsdom environment via the
 * `@jest-environment jsdom` pragma at the top of the test file.
 */
import { toHaveNoViolations } from 'jest-axe';

// `expect.extend` is parameterised by `ExpectExtendMap`, which jest's
// DefinitelyTyped types define as a record keyed by matcher name. The
// matcher shape jest-axe exports is function-like; the cast below keeps the
// runtime contract identical while satisfying strict TS.
expect.extend(toHaveNoViolations as unknown as Parameters<typeof expect.extend>[0]);
