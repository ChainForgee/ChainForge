/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReviewActionDialog } from '../ReviewActionDialog';
import {
  useApproveVerification,
  useRejectVerification,
  useRequestResubmission,
} from '@/hooks/useVerificationInbox';

jest.mock('@/hooks/useVerificationInbox', () => ({
  useApproveVerification: jest.fn(),
  useRejectVerification: jest.fn(),
  useRequestResubmission: jest.fn(),
}));

const mockUseApproveVerification =
  useApproveVerification as jest.MockedFunction<
    typeof useApproveVerification
  >;
const mockUseRejectVerification = useRejectVerification as jest.MockedFunction<
  typeof useRejectVerification
>;
const mockUseRequestResubmission =
  useRequestResubmission as jest.MockedFunction<
    typeof useRequestResubmission
  >;

const approveMutateAsync = jest.fn();
const rejectMutateAsync = jest.fn();
const resubmitMutateAsync = jest.fn();

function mockMutations() {
  mockUseApproveVerification.mockReturnValue({
    mutateAsync: approveMutateAsync,
    isPending: false,
  } as ReturnType<typeof useApproveVerification>);
  mockUseRejectVerification.mockReturnValue({
    mutateAsync: rejectMutateAsync,
    isPending: false,
  } as ReturnType<typeof useRejectVerification>);
  mockUseRequestResubmission.mockReturnValue({
    mutateAsync: resubmitMutateAsync,
    isPending: false,
  } as ReturnType<typeof useRequestResubmission>);
}

describe('ReviewActionDialog', () => {
  beforeEach(() => {
    approveMutateAsync.mockReset();
    rejectMutateAsync.mockReset();
    resubmitMutateAsync.mockReset();
    approveMutateAsync.mockResolvedValue(undefined);
    rejectMutateAsync.mockResolvedValue(undefined);
    resubmitMutateAsync.mockResolvedValue(undefined);
    mockMutations();
  });

  it('approves a verification with optional reviewer messages', async () => {
    const onOpenChange = jest.fn();
    render(
      <ReviewActionDialog
        verificationId="ver-201"
        action="approve"
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Instructions shown to the applicant'), {
      target: { value: 'Payment can proceed.' },
    });
    fireEvent.change(screen.getByPlaceholderText('Private note for the review team'), {
      target: { value: 'Matched government ID.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(approveMutateAsync).toHaveBeenCalledWith({
        id: 'ver-201',
        payload: {
          nextStepMessage: 'Payment can proceed.',
          internalNote: 'Matched government ID.',
        },
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('requires a rejection reason before submitting', () => {
    render(
      <ReviewActionDialog
        verificationId="ver-202"
        action="reject"
        open
        onOpenChange={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    expect(screen.getByText('A reason is required.')).toBeInTheDocument();
    expect(rejectMutateAsync).not.toHaveBeenCalled();
  });

  it('submits rejection and resubmission payloads through the correct hooks', async () => {
    const { rerender } = render(
      <ReviewActionDialog
        verificationId="ver-203"
        action="reject"
        open
        onOpenChange={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. Document appears fraudulent'), {
      target: { value: 'Document image is unreadable.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(rejectMutateAsync).toHaveBeenCalledWith({
        id: 'ver-203',
        payload: {
          rejectionReason: 'Document image is unreadable.',
          nextStepMessage: undefined,
          internalNote: undefined,
        },
      });
    });

    rerender(
      <ReviewActionDialog
        verificationId="ver-204"
        action="resubmission"
        open
        onOpenChange={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. ID document is expired'), {
      target: { value: 'ID document is expired.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Request Resubmission' }),
    );

    await waitFor(() => {
      expect(resubmitMutateAsync).toHaveBeenCalledWith({
        id: 'ver-204',
        payload: {
          rejectionReason: 'ID document is expired.',
          nextStepMessage: 'Please resubmit the required documents.',
          internalNote: undefined,
        },
      });
    });
  });
});
