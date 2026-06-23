/**
 * Minimal ambient declaration for the `jest-axe` runtime.
 *
 * The package ships a runtime that re-exports axe-core plus a
 * `toHaveNoViolations` matcher; it does not yet publish TypeScript types
 * compatible with our `strict` tsconfig. Declaring the surface locally keeps
 * type-checking working without taking on a `@types/jest-axe` dependency.
 *
 * We intentionally do NOT import types from `axe-core` — the project's
 * tsconfig doesn't depend on axe-core types and re-declaring keeps the
 * declaration robust against upstream schema drift.
 */

declare module 'jest-axe' {
    /** Axe impact levels, mirrored from axe-core for type completeness. */
    type Impact = 'minor' | 'moderate' | 'serious' | 'critical' | null;

    /** A single violation node as published by axe-core. */
    interface AxeNodeResult {
        target: ReadonlyArray<string>;
        html: string;
        failureSummary?: string;
        impact?: Impact;
        [key: string]: unknown;
    }

    /** A single rule violation. */
    interface AxeResult {
        id: string;
        impact?: Impact;
        tags: ReadonlyArray<string>;
        description: string;
        help: string;
        helpUrl: string;
        nodes: ReadonlyArray<AxeNodeResult>;
    }

    /** Aggregate axe-core run output. */
    interface AxeResults {
        violations: ReadonlyArray<AxeResult>;
        passes: ReadonlyArray<AxeResult>;
        incomplete: ReadonlyArray<AxeResult>;
        inapplicable: ReadonlyArray<AxeResult>;
        timestamp: string;
        url: string;
    }

    /** Run options accepted by `axe.run`. */
    interface RunOptions {
        [key: string]: unknown;
    }

    /**
     * Run axe-core against the supplied context.
     *
     * @param context The node, selector, or document to scan.
     * @param options Optional axe run options.
     */
    export function axe(context?: unknown, options?: RunOptions): Promise<AxeResults>;

    /** Matcher signature compatible with `expect.extend(...)`. */
    interface AxeMatcher {
        (this: unknown, received: AxeResults): { pass: boolean; message: () => string };
    }

    /** Matcher registered by jest.setup.a11y.ts on the global expect. */
    export const toHaveNoViolations: AxeMatcher;
}

// Augment Jest's Expect to include the custom matcher at the type level.
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace jest {
        interface Matchers<R> {
            toHaveNoViolations(): R;
        }
    }
}
