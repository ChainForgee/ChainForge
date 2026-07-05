/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReviewQueue } from '../ReviewQueue';
import { useInbox } from '@/hooks/useVerificationInbox';
import type {
  ReviewFilters,
  VerificationInboxItem,
  VerificationInboxResponse,
} from '@/types/verification-review';

jest.mock('@/hooks/useVerificationInbox', () => ({
  useInbox: jest.fn(),
}));

jest.mock('../VerificationDetailPanel', () => ({
  VerificationDetailPanel: ({
    verificationId,
    onClose,
  }: {
    verificationId: string;
    onClose: () => void;
  }) => (
    <div data-testid="verification-detail">
      Detail for {verificationId}
      <button type="button" onClick={onClose}>
        Close detail
      </button>
    </div>
  ),
}));

const mockUseInbox = useInbox as jest.MockedFunction<typeof useInbox>;

const filters: ReviewFilters = {
  status: '',
  riskLevel: '',
  dateFrom: '',
  dateTo: '',
  page: 1,
};

const inboxItem: VerificationInboxItem = {
  id: 'ver-101',
  status: 'pending_review',
  createdAt: '2026-07-01T12:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  rejectionReason: null,
  nextStepMessage: 'Confirm identity document',
  deepLink: '/verifications/ver-101',
  riskLevel: 'high',
};

const response: VerificationInboxResponse = {
  items: [inboxItem],
  total: 7,
  page: 2,
  limit: 5,
  totalPages: 3,
};

describe('ReviewQueue', () => {
  beforeEach(() => {
    mockUseInbox.mockReset();
  });

  it('renders loading placeholders while the verification queue is loading', () => {
    mockUseInbox.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useInbox>);

    const { container } = render(
      <ReviewQueue filters={filters} onPageChange={jest.fn()} />,
    );

    expect(container.querySelectorAll('.animate-pulse .h-16')).toHaveLength(5);
  });

  it('renders queue errors from the inbox hook', () => {
    mockUseInbox.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Inbox unavailable'),
    } as ReturnType<typeof useInbox>);

    render(<ReviewQueue filters={filters} onPageChange={jest.fn()} />);

    expect(
      screen.getByText('Failed to load queue: Inbox unavailable'),
    ).toBeInTheDocument();
  });

  it('renders an empty queue message when filters have no matches', () => {
    mockUseInbox.mockReturnValue({
      data: { ...response, items: [], total: 0, totalPages: 1 },
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useInbox>);

    render(<ReviewQueue filters={filters} onPageChange={jest.fn()} />);

    expect(
      screen.getByText('No verification cases match the current filters.'),
    ).toBeInTheDocument();
  });

  it('renders queue rows, opens details, and pages through results', () => {
    const onPageChange = jest.fn();
    mockUseInbox.mockReturnValue({
      data: response,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useInbox>);

    const { container } = render(
      <ReviewQueue filters={filters} onPageChange={onPageChange} />,
    );

    fireEvent.click(screen.getByText('ver-101'));
    expect(screen.getByTestId('verification-detail')).toHaveTextContent(
      'Detail for ver-101',
    );
    expect(screen.getByText('Confirm identity document')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3 · 7 total')).toBeInTheDocument();

    const pagerButtons = container.querySelectorAll('button.h-8');
    fireEvent.click(pagerButtons[0]);
    fireEvent.click(pagerButtons[1]);

    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });
});
