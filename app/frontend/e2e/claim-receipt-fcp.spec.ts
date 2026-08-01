import { test, expect, type CDPSession } from '@playwright/test';

// Chrome DevTools' "Slow 3G" network preset — the standard baseline for
// judging first-contentful-paint on weak mobile networks (see issue #292).
const SLOW_3G = {
  offline: false,
  downloadThroughput: (500 * 1024) / 8, // 500 kb/s
  uploadThroughput: (500 * 1024) / 8,
  latency: 400, // ms
};

const FCP_BUDGET_MS = 1000;

async function throttleToSlow3G(client: CDPSession) {
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', SLOW_3G);
  // A mid-tier/low-end phone CPU is part of "weak mobile networks" in the
  // field — 4x slowdown approximates a budget Android device.
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

async function getFirstContentfulPaint(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const entry = performance
      .getEntriesByType('paint')
      .find((e) => e.name === 'first-contentful-paint');
    return entry ? entry.startTime : null;
  });
}

test.describe('claim-receipt SSR performance', () => {
  test('renders first contentful paint under 1s on a throttled 3G profile', async ({
    page,
  }) => {
    const client = await page.context().newCDPSession(page);
    await throttleToSlow3G(client);

    await page.goto('/en/claim-receipt?claimId=mock-claim-123', {
      waitUntil: 'load',
    });

    // The receipt heading should already be present in the server-rendered
    // HTML — if this fails, the page fell back to a client-side loading
    // spinner instead of SSR-ing the claim data.
    await expect(page.getByRole('heading', { name: 'Claim Receipt' })).toBeVisible();

    const fcp = await getFirstContentfulPaint(page);
    expect(fcp, 'first-contentful-paint entry should exist').not.toBeNull();
    expect(fcp as number).toBeLessThan(FCP_BUDGET_MS);
  });

  test('server-renders the receipt body without a client-side loading state', async ({
    page,
  }) => {
    // No throttling here — this is a functional check that the HTML
    // Playwright receives on first navigation already contains the claim
    // amount, rather than "Loading your receipt…" from a CSR fetch.
    const response = await page.goto('/en/claim-receipt?claimId=mock-claim-123');
    const html = await response?.text();

    expect(html).not.toContain('Loading your receipt');
    expect(html).toContain('Claim Receipt');
  });
});
