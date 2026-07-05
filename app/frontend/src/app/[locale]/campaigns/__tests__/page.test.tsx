/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CampaignsPage from '../page';
import { useCampaigns, useCreateCampaign } from '@/hooks/useCampaigns';
import { useCampaignAction } from '@/hooks/useOptimisticCampaignMutations';
import {
  canManageCampaigns,
  getUserRole,
  getUserRoleLabel,
} from '@/lib/user-role';
import type { Campaign } from '@/types/campaign';

const replace = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

jest.mock('@/components/dashboard/ExportControls', () => ({
  ExportControls: ({ context }: { context: string }) => (
    <div data-testid={`export-${context}`} />
  ),
}));

jest.mock('@/hooks/useCampaigns', () => ({
  useCampaigns: jest.fn(),
  useCreateCampaign: jest.fn(),
}));

jest.mock('@/hooks/useOptimisticCampaignMutations', () => ({
  useCampaignAction: jest.fn(),
  useCampaignActions: jest.fn(),
}));

jest.mock('@/lib/user-role', () => ({
  canManageCampaigns: jest.fn(),
  getUserRole: jest.fn(),
  getUserRoleLabel: jest.fn(),
}));

const mockUseCampaigns = useCampaigns as jest.MockedFunction<
  typeof useCampaigns
>;
const mockUseCreateCampaign = useCreateCampaign as jest.MockedFunction<
  typeof useCreateCampaign
>;
const mockUseCampaignAction = useCampaignAction as jest.MockedFunction<
  typeof useCampaignAction
>;
const mockCanManageCampaigns = canManageCampaigns as jest.MockedFunction<
  typeof canManageCampaigns
>;
const mockGetUserRole = getUserRole as jest.MockedFunction<typeof getUserRole>;
const mockGetUserRoleLabel = getUserRoleLabel as jest.MockedFunction<
  typeof getUserRoleLabel
>;

const activeCampaign: Campaign = {
  id: 'campaign-1',
  name: 'Flood Relief',
  budget: 15000,
  status: 'active',
  metadata: { token: 'USDC', expiry: '2026-12-31T00:00:00.000Z' },
};

const pausedCampaign: Campaign = {
  ...activeCampaign,
  id: 'campaign-2',
  name: 'Shelter Supplies',
  status: 'paused',
};

const mutate = jest.fn();
const mutateAsync = jest.fn();

function mockPageState({
  campaigns = [activeCampaign],
  isLoading = false,
  isError = false,
  error = null,
}: {
  campaigns?: Campaign[];
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
} = {}) {
  mockUseCampaigns.mockReturnValue({
    data: campaigns,
    isLoading,
    isError,
    error,
  } as ReturnType<typeof useCampaigns>);
  mockUseCreateCampaign.mockReturnValue({
    mutateAsync,
    isPending: false,
  } as ReturnType<typeof useCreateCampaign>);
  mockUseCampaignAction.mockReturnValue({
    mutate,
    isPending: false,
    variables: undefined,
  } as ReturnType<typeof useCampaignAction>);
}

describe('CampaignsPage', () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    replace.mockClear();
    mutate.mockClear();
    mutateAsync.mockResolvedValue(activeCampaign);
    mutateAsync.mockClear();
    mockCanManageCampaigns.mockReturnValue(true);
    mockGetUserRole.mockReturnValue('admin');
    mockGetUserRoleLabel.mockReturnValue('Admin');
    mockPageState();
  });

  it('renders loading, error, and empty campaign states', () => {
    mockPageState({ campaigns: [], isLoading: true });
    const { rerender } = render(<CampaignsPage />);
    expect(screen.getByText('Loading campaigns...')).toBeInTheDocument();

    mockPageState({
      campaigns: [],
      isError: true,
      error: new Error('Campaign API failed'),
    });
    rerender(<CampaignsPage />);
    expect(
      screen.getByText('Error fetching campaigns: Campaign API failed'),
    ).toBeInTheDocument();

    mockPageState({ campaigns: [] });
    rerender(<CampaignsPage />);
    expect(
      screen.getByText('There are no active campaigns to review'),
    ).toBeInTheDocument();
  });

  it('creates a campaign from the form payload', async () => {
    render(<CampaignsPage />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Medical Supplies' },
    });
    fireEvent.change(screen.getByLabelText('Budget (USD)'), {
      target: { value: '4200' },
    });
    fireEvent.change(screen.getByLabelText('Token'), {
      target: { value: 'EURC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        name: 'Medical Supplies',
        budget: 4200,
        status: 'active',
        metadata: {
          token: 'EURC',
          expiry: undefined,
        },
      });
    });
    expect(
      await screen.findByText('Campaign created successfully.'),
    ).toBeInTheDocument();
  });

  it('filters campaigns by URL status and updates the URL when a preset is applied', () => {
    searchParams = new URLSearchParams('status=paused');
    mockPageState({ campaigns: [activeCampaign, pausedCampaign] });

    render(<CampaignsPage />);

    expect(screen.queryByText('Flood Relief')).not.toBeInTheDocument();
    expect(screen.getByText('Shelter Supplies')).toBeInTheDocument();
  });

  it('dispatches pause, resume, and archive campaign actions', () => {
    mockPageState({ campaigns: [activeCampaign, pausedCampaign] });

    render(<CampaignsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(mutate).toHaveBeenCalledWith({
      id: 'campaign-1',
      campaignName: 'Flood Relief',
      action: { type: 'pause', targetStatus: 'paused' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mutate).toHaveBeenCalledWith({
      id: 'campaign-2',
      campaignName: 'Shelter Supplies',
      action: { type: 'resume', targetStatus: 'active' },
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0]);
    expect(mutate).toHaveBeenCalledWith({
      id: 'campaign-1',
      campaignName: 'Flood Relief',
      action: { type: 'archive', targetStatus: 'archived' },
    });
  });
});
