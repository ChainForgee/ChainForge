/**
 * Shared helpers for accessibility (jest-axe) tests.
 *
 * Importing this module pulls in jest-axe (registered globally via
 * jest.setup.a11y.ts) and exposes `renderAndCheckA11y` so per-component
 * tests can simply describe their rendered tree and run axe over it.
 *
 * The `rendered` parameter must be a promise (React.render is async-aware
 * with hooks, even when not awaiting Suspense boundaries) — testers can
 * pass a sync render call and jest-axe will still scan the resulting DOM
 * via the synchronous fallback.
 */
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { axe, type Result as AxeResult } from 'jest-axe';
import type { ReactElement } from 'react';

/** Options accepted by `renderAndCheckA11y`. */
export interface A11yOptions extends RenderOptions {
    /**
     * Optional axe.run context object. Defaults to scanning the whole
     * document. Useful for restricting the scan to a specific region.
     */
    axeContext?: Parameters<typeof axe>[1];
}

/** Convenience wrapper that returns the rendered tree and the axe report. */
export async function renderAndCheckA11y(
    ui: ReactElement,
    options: A11yOptions = {},
): Promise<{ result: RenderResult; axeReport: { violations: AxeResult['violations'] } }> {
    const result = render(ui, options);
    const axeReport = await axe(result.container, options.axeContext ?? {});
    return { result, axeReport };
}

/**
 * Pretty-print the severity-impacted rules so failing assertions in CI logs
 * are easy to triage. Returned as a multi-line string for snapshot or
 * message interpolation.
 */
export function summariseViolations(violations: AxeResult['violations']): string {
    if (violations.length === 0) return 'No accessibility violations detected.';
    return violations
        .map((v) => {
            const targets = v.nodes
                .map((n) => n.target.join(' >> '))
                .slice(0, 3)
                .join('\n    - ');
            return `[${v.impact?.toUpperCase() ?? 'UNKNOWN'}] ${v.id}\n  ${v.help}\n  Targets:\n    - ${targets}`;
        })
        .join('\n\n');
}
