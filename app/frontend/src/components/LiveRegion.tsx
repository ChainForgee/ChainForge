import React, { useEffect, useState } from 'react';

export interface LiveRegionProps {
  /** The message to announce. If it changes, the new message will be announced. */
  message: string;
  /** Whether the announcement should be assertive (interrupting) or polite (queued). Default: polite */
  urgency?: 'polite' | 'assertive';
}

/**
 * A visually hidden component that announces status changes to assistive technologies.
 * Use this to ensure screen reader users are notified of dynamic content changes.
 */
export const LiveRegion: React.FC<LiveRegionProps> = ({ message, urgency = 'polite' }) => {
  const [announcedMessage, setAnnouncedMessage] = useState('');

  useEffect(() => {
    if (!message) return;
    
    // Add a small delay to ensure consecutive rapid updates are announced
    // and to ensure it's a distinct DOM update.
    const timer = setTimeout(() => {
      setAnnouncedMessage(message);
    }, 50);

    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div
      aria-live={urgency}
      aria-atomic="true"
      role={urgency === 'assertive' ? 'alert' : 'status'}
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {announcedMessage}
    </div>
  );
};
