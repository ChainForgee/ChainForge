/** @jest-environment jsdom */
import React from 'react';
import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe, toHaveNoViolations } from 'jest-axe';
import { LiveRegion } from '../src/components/LiveRegion';

expect.extend(toHaveNoViolations);

describe('LiveRegion', () => {
  it('renders without accessibility violations', async () => {
    const { container } = render(<LiveRegion message="Initial message" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('updates text content when message changes', async () => {
    jest.useFakeTimers();
    
    const { getByRole, rerender } = render(<LiveRegion message="Pending" />);
    
    // Initially empty due to timeout
    const region = getByRole('status');
    expect(region).toHaveTextContent('');

    // Advance timer
    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(region).toHaveTextContent('Pending');

    rerender(<LiveRegion message="Approved" />);
    
    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(region).toHaveTextContent('Approved');
    
    jest.useRealTimers();
  });

  it('sets appropriate aria attributes', () => {
    const { container } = render(<LiveRegion message="Test" urgency="assertive" />);
    const region = container.firstChild as HTMLElement;
    
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveAttribute('role', 'alert');
  });
});
