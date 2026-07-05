/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { FilteredPackageList } from '../FilteredPackageList';
import { useAidPackages } from '@/hooks/useAidPackages';
import { getAppUserRole } from '@/lib/app-role';
import type { AidPackage } from '@/types/aid-package';

jest.mock('@/hooks/useAidPackages', () => ({
  useAidPackages: jest.fn(),
}));

jest.mock('@/lib/app-role', () => ({
  getAppUserRole: jest.fn(),
  isOperationsRole: (role: string) => role === 'operator',
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

const mockUseAidPackages = useAidPackages as jest.MockedFunction<
  typeof useAidPackages
>;
const mockGetAppUserRole = getAppUserRole as jest.MockedFunction<
  typeof getAppUserRole
>;

const aidPackage: AidPackage = {
  id: 'aid-001',
  title: 'Winter Relief',
  region: 'North District',
  amount: '$2,500',
  recipients: 14,
  status: 'Active',
  token: 'USDC',
};

describe('FilteredPackageList', () => {
  beforeEach(() => {
    mockGetAppUserRole.mockReturnValue('operator');
  });

  it('renders loading rows while aid packages are loading', () => {
    mockUseAidPackages.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as ReturnType<typeof useAidPackages>);

    const { container } = render(<FilteredPackageList filters={{}} />);

    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(
      0,
    );
  });

  it('renders an error state when the aid package query fails', () => {
    mockUseAidPackages.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Backend unavailable'),
    } as ReturnType<typeof useAidPackages>);

    render(<FilteredPackageList filters={{}} />);

    expect(
      screen.getByText('Error loading packages: Backend unavailable'),
    ).toBeInTheDocument();
  });

  it('renders an empty state with filtered guidance when filters return no rows', () => {
    mockUseAidPackages.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAidPackages>);

    render(<FilteredPackageList filters={{ search: 'coastal' }} />);

    expect(
      screen.getAllByText('No aid packages match the current filters')[0],
    ).toBeInTheDocument();
    expect(screen.getAllByText('Reset dashboard filters')[0]).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('renders package data in the desktop table and mobile cards', () => {
    mockUseAidPackages.mockReturnValue({
      data: [aidPackage],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAidPackages>);

    render(<FilteredPackageList filters={{ status: 'Active' }} />);

    expect(screen.getAllByText('Winter Relief')).toHaveLength(2);
    expect(screen.getAllByText('North District')).toHaveLength(2);
    expect(screen.getAllByText('USDC')).toHaveLength(2);
    expect(screen.getAllByText('aid-001')).toHaveLength(2);
  });
});
