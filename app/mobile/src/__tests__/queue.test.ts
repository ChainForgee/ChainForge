/**
 * Unit tests for src/services/queue.ts
 */
import {
  fetchWithRetry,
  fetchWithQueue,
  queueOfflineRequest,
  drainOfflineQueue,
  getOfflineQueueState,
  clearOfflineQueue,
} from '../services/queue';

// Mock the syncQueue module to avoid external dependencies
jest.mock('../services/syncQueue', () => ({
  flushPendingNetworkActions: jest.fn().mockResolvedValue(undefined),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  clearOfflineQueue();
});

describe('fetchWithRetry', () => {
  it('returns response on first success', async () => {
    const payload = { status: 'ok' };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });
    const result = await fetchWithRetry('https://api.example.com/health');
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 error and succeeds eventually', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 503 error and succeeds eventually', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 rate limit error and succeeds eventually', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries on persistent 500 errors', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 }),
    ).rejects.toThrow('HTTP error! status: 500');
    expect(mockFetch).toHaveBeenCalledTimes(4); // Initial + 3 retries
  });

  it('retries on network error and succeeds eventually', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on timeout error and succeeds eventually', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx client errors', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 })).rejects.toThrow('HTTP error! status: 404');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 unauthorized', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 })).rejects.toThrow('HTTP error! status: 401');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('respects custom maxRetries option', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchWithRetry('https://api.example.com/health', undefined, { maxRetries: 1, baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff with jitter', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => payload });

    const startTime = Date.now();
    await fetchWithRetry('https://api.example.com/health', undefined, { baseDelayMs: 10 });
    const elapsed = Date.now() - startTime;
    
    // Should have waited at least 30ms total (10 + 20)
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('queueOfflineRequest', () => {
  it('adds request to offline queue', () => {
    const request = queueOfflineRequest('https://api.example.com/data', { method: 'GET' });
    
    expect(request.url).toBe('https://api.example.com/data');
    expect(request.options).toEqual({ method: 'GET' });
    expect(request.retryCount).toBe(0);
    expect(request.id).toBeDefined();
  });

  it('generates unique IDs for each request', () => {
    const request1 = queueOfflineRequest('https://api.example.com/data');
    const request2 = queueOfflineRequest('https://api.example.com/data');
    
    expect(request1.id).not.toBe(request2.id);
  });

  it('stores requests in queue', () => {
    queueOfflineRequest('https://api.example.com/data1');
    queueOfflineRequest('https://api.example.com/data2');
    
    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(2);
  });
});

describe('fetchWithQueue', () => {
  it('returns response when online', async () => {
    const payload = { status: 'ok' };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });

    const result = await fetchWithQueue('https://api.example.com/health', undefined, { isOnline: true });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('queues request when offline', async () => {
    await expect(
      fetchWithQueue('https://api.example.com/health', undefined, { isOnline: false }),
    ).rejects.toThrow('Offline: request queued');

    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(1);
    expect(queue[0].url).toBe('https://api.example.com/health');
  });

  it('queues request on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network request failed'));

    await expect(
      fetchWithQueue('https://api.example.com/health', undefined, { isOnline: true, baseDelayMs: 10 }),
    ).rejects.toThrow();

    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(1);
  });

  it('does not queue request on non-retryable error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(
      fetchWithQueue('https://api.example.com/health', undefined, { isOnline: true, baseDelayMs: 10 }),
    ).rejects.toThrow();

    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(0);
  });

  it('retries with exponential backoff before throwing error', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      fetchWithQueue('https://api.example.com/health', undefined, { isOnline: true, baseDelayMs: 10 }),
    ).rejects.toThrow();

    // Server errors after exhausting retries should NOT be queued
    // Only network/offline errors should be queued
    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

describe('drainOfflineQueue', () => {
  it('processes queued requests when online', async () => {
    const payload = { status: 'ok' };
    mockFetch.mockResolvedValue({ ok: true, json: async () => payload });

    queueOfflineRequest('https://api.example.com/data1');
    queueOfflineRequest('https://api.example.com/data2');

    await drainOfflineQueue();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(getOfflineQueueState()).toHaveLength(0);
  });

  it('clears queue after successful processing', async () => {
    const payload = { status: 'ok' };
    mockFetch.mockResolvedValue({ ok: true, json: async () => payload });

    queueOfflineRequest('https://api.example.com/data');
    expect(getOfflineQueueState()).toHaveLength(1);

    await drainOfflineQueue();

    expect(getOfflineQueueState()).toHaveLength(0);
  });

  it('re-queues failed requests with incremented retry count', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    queueOfflineRequest('https://api.example.com/data');

    await drainOfflineQueue({ baseDelayMs: 10 });

    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(1);
    expect(queue[0].retryCount).toBe(1);
  });

  it('removes requests after max retries', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const request = queueOfflineRequest('https://api.example.com/data');
    request.retryCount = 3; // Already at max retries

    await drainOfflineQueue({ baseDelayMs: 10 });

    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(0);
  });

  it('does nothing when queue is empty', async () => {
    await drainOfflineQueue();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles mix of successful and failed requests', async () => {
    const payload = { status: 'ok' };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => payload }) // data1 success
      .mockRejectedValueOnce(new Error('Network error')) // data2 fail
      .mockRejectedValueOnce(new Error('Network error')) // data2 retry 1
      .mockRejectedValueOnce(new Error('Network error')) // data2 retry 2
      .mockRejectedValueOnce(new Error('Network error')) // data2 retry 3
      .mockResolvedValueOnce({ ok: true, json: async () => payload }); // data3 success

    queueOfflineRequest('https://api.example.com/data1');
    queueOfflineRequest('https://api.example.com/data2');
    queueOfflineRequest('https://api.example.com/data3');

    await drainOfflineQueue({ baseDelayMs: 10 });

    // First request succeeds immediately (1 call)
    // Second request fails, gets retried 3 times (4 calls total for this request)
    // Third request succeeds (1 call)
    // Total: 6 calls
    expect(mockFetch).toHaveBeenCalledTimes(6);
    const queue = getOfflineQueueState();
    expect(queue).toHaveLength(1);
    expect(queue[0].url).toBe('https://api.example.com/data2');
    expect(queue[0].retryCount).toBe(1);
  });
});

describe('getOfflineQueueState', () => {
  it('returns copy of queue state', () => {
    queueOfflineRequest('https://api.example.com/data');
    
    const state1 = getOfflineQueueState();
    const state2 = getOfflineQueueState();
    
    expect(state1).toEqual(state2);
    expect(state1).not.toBe(state2);
  });

  it('returns empty array when queue is empty', () => {
    const state = getOfflineQueueState();
    expect(state).toEqual([]);
  });
});

describe('clearOfflineQueue', () => {
  it('clears all queued requests', () => {
    queueOfflineRequest('https://api.example.com/data1');
    queueOfflineRequest('https://api.example.com/data2');
    
    expect(getOfflineQueueState()).toHaveLength(2);
    
    clearOfflineQueue();
    
    expect(getOfflineQueueState()).toHaveLength(0);
  });
});
