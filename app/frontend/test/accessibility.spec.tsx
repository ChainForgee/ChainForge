/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AidPackage } from '@/types/aid-package';
import type { Campaign } from '@/types/campaign';
import Home from '@/app/[locale]/page';
import CampaignsPage from '@/app/[locale]/campaigns/page';
import ClaimReceiptPage from '@/app/[locale]/claim-receipt/page';

expect.extend(toHaveNoViolations);

// jsdom has no layout engine, so color-contrast cannot be computed here.
// Contrast is tracked in docs/accessibility/audit-2026.md as a manual check.
const axeConfig = {
  rules: {
    'color-contrast': { enabled: false },
  },
};

const mockSearchParams = { current: new URLSearchParams() };

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    back: jest.fn(),
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
  useSearchParams: () => mockSearchParams.current,
  usePathname: () => '/',
}));

const aidPackages: AidPackage[] = [
  {
    id: 'pkg-001',
    title: 'Winter Relief Kit',
    region: 'Northern Region',
    amount: '150',
    recipients: 40,
    status: 'Active',
    token: 'USDC',
  },
  {
    id: 'pkg-002',
    title: 'Food Assistance',
    region: 'Coastal Region',
    amount: '75',
    recipients: 120,
    status: 'Claimed',
    token: 'XLM',
  },
];

jest.mock('@/hooks/useAidPackages', () => ({
  useAidPackages: () => ({
    data: aidPackages,
    isLoading: false,
    error: null,
  }),
}));

const campaigns: Campaign[] = [
  {
    id: 'camp-001',
    name: 'Winter Relief 2026',
    budget: 25000,
    status: 'active',
    metadata: { token: 'USDC', expiry: '2026-12-31T00:00:00.000Z' },
  },
  {
    id: 'camp-002',
    name: 'Emergency Cash Transfer',
    budget: 15000,
    status: 'paused',
    metadata: { token: 'XLM' },
  },
];

jest.mock('@/hooks/useCampaigns', () => ({
  useCampaigns: () => ({
    data: campaigns,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useCreateCampaign: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
  }),
}));

jest.mock('@/hooks/useOptimisticCampaignMutations', () => ({
  useCampaignAction: () => ({
    mutate: jest.fn(),
    isPending: false,
    variables: undefined,
  }),
  useCampaignActions: () => ({
    canPause: true,
    canResume: false,
    canArchive: true,
    canComplete: true,
    canActivate: false,
  }),
}));

beforeAll(() => {
  // next-themes reads matchMedia, which jsdom does not implement
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});

const savedUserRole = process.env.NEXT_PUBLIC_USER_ROLE;

beforeEach(() => {
  mockSearchParams.current = new URLSearchParams();
  delete process.env.NEXT_PUBLIC_USER_ROLE;
});

afterEach(() => {
  if (savedUserRole === undefined) {
    delete process.env.NEXT_PUBLIC_USER_ROLE;
  } else {
    process.env.NEXT_PUBLIC_USER_ROLE = savedUserRole;
  }
});

// The pages under test render hardcoded English copy and do not call
// next-intl hooks, so no NextIntlClientProvider is needed (next-intl is
// ESM-only and would require extra jest transform config).
function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('accessibility (axe, WCAG 2.2 AA automated subset)', () => {
  it('home page has no axe violations', async () => {
    const ui = await Home({ params: Promise.resolve({ locale: 'en' }) });
    const { container } = renderWithProviders(ui);

    await waitFor(() => {
      expect(screen.getByText('Available Aid Packages')).toBeInTheDocument();
    });

    expect(await axe(container, axeConfig)).toHaveNoViolations();
  });

  it('campaigns page (ngo role) has no axe violations', async () => {
    process.env.NEXT_PUBLIC_USER_ROLE = 'ngo';
    const { container } = renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('NGO Campaigns')).toBeInTheDocument();
      expect(screen.getByText('Winter Relief 2026')).toBeInTheDocument();
    });

    expect(await axe(container, axeConfig)).toHaveNoViolations();
  });

  it('campaigns page (guest role, access denied) has no axe violations', async () => {
    const { container } = renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });

    expect(await axe(container, axeConfig)).toHaveNoViolations();
  });

  it('claim receipt page with claimId has no axe violations', async () => {
    mockSearchParams.current = new URLSearchParams('claimId=claim-123');
    const { container } = renderWithProviders(<ClaimReceiptPage />);

    await waitFor(() => {
      expect(screen.getByText('What is this receipt?')).toBeInTheDocument();
    });

    expect(await axe(container, axeConfig)).toHaveNoViolations();
  });

  it('claim receipt page without claimId (error state) has no axe violations', async () => {
    const { container } = renderWithProviders(<ClaimReceiptPage />);

    await waitFor(() => {
      expect(screen.getByText('Claim ID not provided')).toBeInTheDocument();
    });

    expect(await axe(container, axeConfig)).toHaveNoViolations();
  });
});
