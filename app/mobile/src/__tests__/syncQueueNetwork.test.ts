import AsyncStorage from '@react-native-async-storage/async-storage';

const QUEUE_KEY = '@chainforge/sync-queue';
const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

type SyncQueueModule = typeof import('../services/syncQueue');

const clearStorage = async () => {
  await (AsyncStorage as unknown as { clear: () => Promise<void> }).clear();
};

const loadFreshQueue = (): SyncQueueModule => {
  let mod!: SyncQueueModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../services/syncQueue') as SyncQueueModule;
  });
  return mod;
};

describe('syncQueue network behavior', () => {
  beforeEach(async () => {
    await clearStorage();
    mockFetch.mockReset();
  });

  it('queues claim confirmation while offline and flushes it when online', async () => {
    const {
      dispatchNetworkAction,
      flushPendingNetworkActions,
      getSyncQueueState,
    } = loadFreshQueue();

    const queued = await dispatchNetworkAction(
      {
        type: 'claim-confirmation',
        payload: { aidId: 'aid-1', claimId: 'claim-1' },
      },
      { online: false },
    );
    expect(queued.status).toBe('queued');
    expect((await getSyncQueueState()).items).toHaveLength(1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'verified' }),
    });

    await flushPendingNetworkActions({ online: true });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/claims\/claim-1\/verify$/),
      { method: 'POST' },
    );
    const state = await getSyncQueueState();
    expect(state.items).toHaveLength(0);
    expect(state.lastSyncError).toBeNull();
  });

  it('marks retryable failures as retrying and persists the last error', async () => {
    const {
      dispatchNetworkAction,
      flushPendingNetworkActions,
      getSyncQueueState,
    } = loadFreshQueue();

    await dispatchNetworkAction(
      {
        type: 'claim-confirmation',
        payload: { aidId: 'aid-1', claimId: 'claim-1' },
      },
      { online: false },
    );
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    await flushPendingNetworkActions({ online: true });

    const [item] = (await getSyncQueueState()).items;
    expect(item.state).toBe('retrying');
    expect(item.retryCount).toBe(1);
    expect(item.lastError).toBe('HTTP error! status: 503');
  });

  it('limits saver-mode flushes to two network actions per cycle', async () => {
    const {
      dispatchNetworkAction,
      flushPendingNetworkActions,
      getSyncQueueState,
    } = loadFreshQueue();

    for (const id of ['one', 'two', 'three']) {
      await dispatchNetworkAction(
        {
          type: 'evidence-upload',
          payload: {
            aidId: `aid-${id}`,
            url: `https://example.test/upload/${id}`,
            body: id,
          },
        },
        { online: false },
      );
    }

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ uploaded: true }),
    });

    await flushPendingNetworkActions({ online: true, saverMode: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const state = await getSyncQueueState();
    expect(state.items).toHaveLength(1);
    expect(
      JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]'),
    ).toHaveLength(1);
  });
});
