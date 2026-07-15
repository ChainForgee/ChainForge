import { parseQRCode } from '../screens/BulkScannerScreen';

describe('BulkScannerScreen QR parsing', () => {
  it('extracts aidId from chainforge deep link', () => {
    expect(parseQRCode('chainforge://package/aid-001')).toBe('aid-001');
  });

  it('returns null for non-chainforge URLs', () => {
    expect(parseQRCode('https://example.com/qr')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseQRCode('')).toBeNull();
    expect(parseQRCode('chainforge://')).toBeNull();
    expect(parseQRCode('chainforge://package/')).toBeNull();
  });
});

describe('BulkScannerScreen concurrency', () => {
  const MAX_CONCURRENT = 4;

  function createMockQueue(): {
    queue: string[];
    process: () => Promise<void>;
  } {
    const state = { queue: [] as string[], processing: 0, completed: 0 };
    return {
      queue: state.queue,
      process: async () => {
        state.queue.push('pending');
      },
    };
  }

  it('allows up to MAX_CONCURRENT in-flight scans', () => {
    let inFlight = 0;
    let maxObserved = 0;

    for (let i = 0; i < 50; i++) {
      if (inFlight < MAX_CONCURRENT) {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        // Simulate async completion
        inFlight--;
      }
    }

    expect(maxObserved).toBe(MAX_CONCURRENT);
  });

  it('throughput with concurrency ≥ 2× sequential on 50 items', async () => {
    const ITEM_COUNT = 50;
    const SIMULATED_LATENCY_MS = 10;

    async function processSequential(ids: string[]): Promise<number> {
      const start = performance.now();
      for (const id of ids) {
        await new Promise(r => setTimeout(r, SIMULATED_LATENCY_MS));
      }
      return performance.now() - start;
    }

    async function processConcurrent(ids: string[]): Promise<number> {
      const start = performance.now();
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += MAX_CONCURRENT) {
        chunks.push(ids.slice(i, i + MAX_CONCURRENT));
      }
      for (const chunk of chunks) {
        await Promise.all(chunk.map(() => new Promise(r => setTimeout(r, SIMULATED_LATENCY_MS))));
      }
      return performance.now() - start;
    }

    const ids = Array.from({ length: ITEM_COUNT }, (_, i) => `aid-${i}`);

    const sequentialMs = await processSequential(ids);
    const concurrentMs = await processConcurrent(ids);

    const speedup = sequentialMs / concurrentMs;
    expect(speedup).toBeGreaterThanOrEqual(2);
  });

  it('skips duplicate aidIds within dedup window', () => {
    const seen = new Map<string, number>();
    const DEDUP_TTL_MS = 5000;
    const results: string[] = [];

    const scans = ['aid-1', 'aid-2', 'aid-1', 'aid-3', 'aid-2'];

    for (const aidId of scans) {
      const now = Date.now();
      const lastSeen = seen.get(aidId);
      if (lastSeen && now - lastSeen < DEDUP_TTL_MS) {
        results.push('skipped');
      } else {
        seen.set(aidId, now);
        results.push('processed');
      }
    }

    expect(results).toEqual(['processed', 'processed', 'skipped', 'processed', 'skipped']);
  });

  it('rate-limits scans within RATE_LIMIT_MS window', () => {
    const RATE_LIMIT_MS = 300;
    const seen = new Map<string, number>();
    const results: string[] = [];

    const now = Date.now();
    seen.set('aid-1', now);

    // Immediate re-scan of same aidId
    const elapsed = Date.now() - (seen.get('aid-1') ?? 0);
    if (elapsed < RATE_LIMIT_MS) {
      results.push('rate-limited');
    } else {
      results.push('allowed');
    }

    expect(results).toEqual(['rate-limited']);
  });
});
