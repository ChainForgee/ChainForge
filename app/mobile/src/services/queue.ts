import { flushPendingNetworkActions } from './syncQueue';

export interface FetchWithQueueOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  isOnline?: boolean;
}

export interface QueuedFetchRequest {
  id: string;
  url: string;
  options?: RequestInit;
  timestamp: string;
  retryCount: number;
}

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Calculates exponential backoff delay with jitter
 */
const calculateBackoff = (retryCount: number, baseDelayMs: number = BASE_DELAY_MS): number => {
  const exponentialDelay = baseDelayMs * Math.pow(2, retryCount);
  // Add jitter to avoid thundering herd problem
  const jitter = Math.random() * 0.1 * exponentialDelay;
  return exponentialDelay + jitter;
};

/**
 * Checks if an error is retryable based on status code or error type
 */
const isRetryableError = (error: unknown, response?: Response): boolean => {
  if (response) {
    const status = response.status;
    // Retry on 5xx server errors and 429 (rate limit)
    return status >= 500 || status === 429;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('failed to fetch') ||
      message.includes('request failed') ||
      message.includes('offline')
    );
  }

  return false;
};

/**
 * Fetch middleware with retry logic and exponential backoff
 * Retries up to 3 times with exponential backoff on retryable errors
 */
export const fetchWithRetry = async (
  url: string,
  options?: RequestInit,
  queueOptions?: FetchWithQueueOptions,
): Promise<Response> => {
  const maxRetries = queueOptions?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = queueOptions?.baseDelayMs ?? BASE_DELAY_MS;

  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (!response) {
        throw new Error('No response received');
      }

      lastResponse = response;

      if (response.ok) {
        return response;
      }

      // Check if error is retryable
      if (isRetryableError(undefined, response) && attempt < maxRetries) {
        const delay = calculateBackoff(attempt, baseDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error or max retries reached
      throw new Error(`HTTP error! status: ${response.status}`);
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      if (isRetryableError(error) && attempt < maxRetries) {
        const delay = calculateBackoff(attempt, baseDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error or max retries reached
      throw error;
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error('Max retries exceeded');
};

/**
 * Checks if an error should be queued for offline processing
 * This is different from retryable - we only queue if it's a genuine network/offline issue
 * not if we've already exhausted retries on a server error
 */
const shouldQueueError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('failed to fetch') ||
      message.includes('request failed') ||
      message.includes('offline')
    );
  }

  return false;
};

/**
 * In-memory queue for offline requests
 * In production, this should be persisted to AsyncStorage
 */
const offlineQueue: QueuedFetchRequest[] = [];

/**
 * Adds a request to the offline queue
 */
export const queueOfflineRequest = (url: string, options?: RequestInit): QueuedFetchRequest => {
  const request: QueuedFetchRequest = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    url,
    options,
    timestamp: new Date().toISOString(),
    retryCount: 0,
  };
  offlineQueue.push(request);
  return request;
};

/**
 * Drains the offline queue when connection is restored
 * Uses SyncContext's flushPendingNetworkActions for coordination
 */
export const drainOfflineQueue = async (options?: FetchWithQueueOptions): Promise<void> => {
  if (offlineQueue.length === 0) {
    return;
  }

  // Trigger SyncContext flush to coordinate with other sync operations
  await flushPendingNetworkActions({ online: true });

  // Process queued requests
  const requestsToProcess = [...offlineQueue];
  offlineQueue.length = 0; // Clear the queue

  for (const request of requestsToProcess) {
    try {
      await fetchWithRetry(request.url, request.options, { 
        maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
        baseDelayMs: options?.baseDelayMs ?? BASE_DELAY_MS,
      });
    } catch (error) {
      console.error(`Failed to process queued request ${request.id}:`, error);
      // Re-queue failed requests with incremented retry count
      if (request.retryCount < DEFAULT_MAX_RETRIES) {
        request.retryCount++;
        offlineQueue.push(request);
      }
    }
  }
};

/**
 * Fetch middleware with retry logic and offline queue support
 * - Retries up to 3 times with exponential backoff on retryable errors
 * - On offline detection, queues requests and drains via SyncContext
 */
export const fetchWithQueue = async (
  url: string,
  options?: RequestInit,
  queueOptions?: FetchWithQueueOptions,
): Promise<Response> => {
  const isOnline = queueOptions?.isOnline ?? true;

  if (!isOnline) {
    // Queue the request for later
    queueOfflineRequest(url, options);
    throw new Error('Offline: request queued');
  }

  try {
    return await fetchWithRetry(url, options, queueOptions);
  } catch (error) {
    // If the error is network/offline-related (not exhausted server retries), queue the request
    if (shouldQueueError(error)) {
      queueOfflineRequest(url, options);
    }
    throw error;
  }
};

/**
 * Gets the current offline queue state (for testing/monitoring)
 */
export const getOfflineQueueState = (): QueuedFetchRequest[] => {
  return [...offlineQueue];
};

/**
 * Clears the offline queue (for testing)
 */
export const clearOfflineQueue = (): void => {
  offlineQueue.length = 0;
};
