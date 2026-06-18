const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function isRetryable(error: unknown): boolean {
  if (error instanceof Response || (error && typeof (error as { status?: number }).status === 'number')) {
    const status = (error as { status: number }).status;
    return status >= 500;
  }
  // Network errors (fetch throws TypeError)
  if (error instanceof TypeError) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('500')
  );
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
