import React from 'react';
import { AlertCircle } from 'lucide-react';
import { ClaimReceipt, ClaimReceiptData } from '@/components/ClaimReceipt';
import { apiClient } from '@/lib/api-client';
import { BackButton } from './BackButton';

// This page is backed by /api/v1/claims/{id}/receipt, which is per-recipient
// data guarded by the backend's HttpCacheInterceptor (private, must-revalidate —
// see #32). It must be rendered fresh on every request rather than statically
// optimized, so the server always re-validates against that header instead of
// serving a stale Next.js Data/Full Route Cache entry.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ claimId?: string }>;
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 flex gap-4">
      <AlertCircle className="text-red-600 dark:text-red-400 flex-shrink-0" size={24} />
      <div>
        <h2 className="font-semibold text-red-900 dark:text-red-100 mb-1">
          Error
        </h2>
        <p className="text-red-800 dark:text-red-200">{message}</p>
      </div>
    </div>
  );
}

async function loadClaim(
  claimId: string,
): Promise<{ claim: ClaimReceiptData | null; error: string | null }> {
  try {
    const { data, error, response } = await apiClient.GET(
      '/api/v1/claims/{id}/receipt',
      {
        params: { path: { id: claimId } },
        // Never let the Next.js server-side data cache serve a stale receipt —
        // the backend's own Cache-Control header (private, must-revalidate)
        // governs revalidation once it reaches the browser/CDN.
        cache: 'no-store',
      } as Parameters<typeof apiClient.GET>[1],
    );

    if (error || !data) {
      if (response?.status === 404) {
        return { claim: null, error: 'Claim receipt not found' };
      }
      return { claim: null, error: 'Failed to load claim receipt' };
    }

    return { claim: data as ClaimReceiptData, error: null };
  } catch (err) {
    return {
      claim: null,
      error: err instanceof Error ? err.message : 'Failed to load claim receipt',
    };
  }
}

export default async function ClaimReceiptPage({ searchParams }: PageProps) {
  const { claimId } = await searchParams;

  const { claim, error } = claimId
    ? await loadClaim(claimId)
    : { claim: null, error: 'Claim ID not provided' };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <BackButton />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">
            Claim Receipt
          </h1>
          <p className="text-slate-600 dark:text-slate-400">
            View and share your claim proof
          </p>
        </div>

        {/* Error State */}
        {error && <ErrorState message={error} />}

        {/* Receipt Card */}
        {!error && claim && (
          <div className="space-y-4">
            <ClaimReceipt claim={claim} />

            {/* Additional Information */}
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-6 border border-slate-200 dark:border-slate-700">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
                What is this receipt?
              </h2>
              <ul className="space-y-3 text-slate-700 dark:text-slate-300">
                <li className="flex gap-3">
                  <span className="text-blue-600 dark:text-blue-400 font-bold">•</span>
                  <span>
                    This receipt proves that your claim has been processed and
                    completed on the ChainForge platform.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="text-blue-600 dark:text-blue-400 font-bold">•</span>
                  <span>
                    You can share this receipt with other parties as proof of
                    the transaction.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="text-blue-600 dark:text-blue-400 font-bold">•</span>
                  <span>
                    Keep this receipt for your records. The data cannot be
                    altered after generation.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="text-blue-600 dark:text-blue-400 font-bold">•</span>
                  <span>
                    You can download, copy, or share this receipt using the
                    buttons above.
                  </span>
                </li>
              </ul>
            </div>

            {/* Support Information */}
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-6 border border-blue-200 dark:border-blue-800">
              <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                Need help?
              </h3>
              <p className="text-blue-800 dark:text-blue-200 text-sm">
                If you have questions about your claim or receipt, please
                contact our support team at hello@chainforge.dev
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
