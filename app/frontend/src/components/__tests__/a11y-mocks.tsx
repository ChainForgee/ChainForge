/**
 * Common Jest mock setup that exercises the project's accessibility tests.
 *
 * Importing this file once is enough to satisfy every external dependency
 * the a11y suite touches (Next.js navigation, next-intl, Freighter wallet).
 * Tests can then focus on rendering components and asserting the axe scan
 * passes.
 *
 * Usage: `import './a11y-mocks';`
 */

import '@testing-library/jest-dom';

// --- Next.js ---------------------------------------------------------------

jest.mock('next/link', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MockLink = ({ children, href, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : '#'} {...rest}>
            {children}
        </a>
    );
    MockLink.displayName = 'MockLink';
    return MockLink;
});

jest.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

// --- next-intl -------------------------------------------------------------

jest.mock('next-intl', () => {
    const identity = (key: string) => key;
    return {
        useTranslations: () => identity,
        useFormatter: () => ({
            formatDateTime: (date: Date) => date.toISOString(),
            formatRelativeTimeValue: () => ({ key: 'activity.justNow', count: 0 }),
            formatNumber: (n: number) => n.toString(),
        }),
        useLocale: () => 'en',
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
        useMessages: () => ({}),
    };
});

// --- @stellar/freighter-api ------------------------------------------------

jest.mock('@stellar/freighter-api', () => ({
    isConnected: jest.fn().mockResolvedValue({ isConnected: false }),
    setAllowed: jest.fn().mockResolvedValue(undefined),
    getAddress: jest.fn().mockResolvedValue({ address: '' }),
    getNetworkDetails: jest.fn().mockResolvedValue({ network: 'TESTNET' }),
    requestAccess: jest.fn().mockResolvedValue(undefined),
    signTransaction: jest.fn().mockResolvedValue({ signedTxXdr: '' }),
}));

// --- @/lib/walletStore -----------------------------------------------------

jest.mock('@/lib/walletStore', () => ({
    useWalletStore: () => ({
        publicKey: null,
        setPublicKey: jest.fn(),
        network: 'TESTNET',
        setNetwork: jest.fn(),
        disconnect: jest.fn(),
    }),
}));

// --- React Query (HealthBadge uses useHealthStatus -> useQuery) -----------

jest.mock('@/hooks/useHealthStatus', () => ({
    useHealthStatus: () => ({
        state: 'ok',
        data: null,
        error: null,
        lastChecked: null,
    }),
}));

// --- ToastProvider / useToast (used by WalletConnect inside Navbar) --------

jest.mock('@/components/ToastProvider', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const React = require('react') as typeof import('react');
    const Ctx = React.createContext<{ toast: jest.Mock } | null>(null);

    const Provider = ({ children }: { children: React.ReactNode }) =>
        React.createElement(
            Ctx.Provider,
            { value: { toast: jest.fn() } },
            children,
        );
    Provider.displayName = 'MockToastProvider';

    const useToast = () => {
        const ctx = React.useContext(Ctx);
        return ctx ?? { toast: jest.fn() };
    };

    return {
        __esModule: true,
        default: Provider,
        ToastProvider: Provider,
        useToast,
    };
});

// --- useActivity hook (used inside VerificationFlow etc.) -----------------

jest.mock('@/hooks/useActivity', () => ({
    useActivity: () => ({
        trackJob: jest.fn(async (_title: string, _description: string, fn: () => Promise<unknown>) => fn()),
        activities: [],
        addActivity: jest.fn(),
        removeActivity: jest.fn(),
        clearCompleted: jest.fn(),
        updateActivity: jest.fn(),
    }),
}));

// --- useAidPackages hook (used in AidPackageList) --------------------------

jest.mock('@/hooks/useAidPackages', () => ({
    useAidPackages: () => ({
        data: [],
        isLoading: false,
        error: null,
    }),
}));

// --- Browser / DOM globals missing in jsdom --------------------------------

if (typeof window !== 'undefined' && !window.matchMedia) {
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
}
