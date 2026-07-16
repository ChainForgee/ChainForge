'use client';

import { useRouter } from 'next/navigation';

export function BackButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      className="text-blue-600 dark:text-blue-400 hover:underline mb-4 flex items-center gap-2"
    >
      ← Back
    </button>
  );
}
