/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReviewFiltersBar } from '../ReviewFiltersBar';
import type { ReviewFilters } from '@/types/verification-review';

const baseFilters: ReviewFilters = {
  status: '',
  riskLevel: '',
  dateFrom: '',
  dateTo: '',
  page: 1,
};

describe('ReviewFiltersBar', () => {
  it('updates date filters and resets pagination', () => {
    const onChange = jest.fn();
    const { container } = render(
      <ReviewFiltersBar filters={baseFilters} onChange={onChange} />,
    );

    const [fromInput, toInput] = container.querySelectorAll(
      'input[type="date"]',
    );

    fireEvent.change(fromInput, { target: { value: '2026-07-01' } });
    fireEvent.change(toInput, { target: { value: '2026-07-05' } });

    expect(onChange).toHaveBeenNthCalledWith(1, {
      dateFrom: '2026-07-01',
      page: 1,
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      dateTo: '2026-07-05',
      page: 1,
    });
  });

  it('clears active status, risk, and date filters', () => {
    const onChange = jest.fn();
    render(
      <ReviewFiltersBar
        filters={{
          status: 'pending_review',
          riskLevel: 'high',
          dateFrom: '2026-07-01',
          dateTo: '2026-07-05',
          page: 4,
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith({
      status: '',
      riskLevel: '',
      dateFrom: '',
      dateTo: '',
      page: 1,
    });
  });
});
