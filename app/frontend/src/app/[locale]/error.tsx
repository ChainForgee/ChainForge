'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ErrorState';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report error to Sentry (or any configured error tracker)
    Sentry.captureException(error);
    if (process.env.NODE_ENV !== 'production') {
      console.error('Error boundary caught an error.', error);
    }
  }, [error]);

  return (
    <>
      <ErrorState
        title="We couldn't load this page"
        description="ChainForge ran into a temporary problem while preparing this route. Try again or visit the status page for more information."
        error={error}
        onTryAgain={reset}
      />
      <div className="mt-4 text-center">
        <Link href="/status" className="text-blue-600 hover:underline">
          View system status
        </Link>
      </div>
    </>
  );
}
