import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cacheAidList,
  clearAidCache,
  getCacheTimestamp,
  loadCachedAidList,
} from '../services/aidCache';
import { AidPackage } from '../services/api';

const clearStorage = async () => {
  await (AsyncStorage as unknown as { clear: () => Promise<void> }).clear();
};

describe('aidCache service', () => {
  beforeEach(async () => {
    await clearStorage();
    jest.restoreAllMocks();
  });

  it('returns null when no aid list is cached', async () => {
    await expect(loadCachedAidList()).resolves.toBeNull();
  });

  it('persists and loads the aid overview list', async () => {
    const aidList: AidPackage[] = [
      {
        id: 'aid-1',
        title: 'Food Aid',
        amount: 500,
        status: 'active',
        date: '2026-01-01',
      },
      {
        id: 'aid-2',
        title: 'Medical Aid',
        amount: 1200,
        status: 'pending',
        date: '2026-01-02',
      },
    ];

    await cacheAidList(aidList);

    await expect(loadCachedAidList()).resolves.toEqual(aidList);
  });

  it('records the cache write timestamp', async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await cacheAidList([]);

    await expect(getCacheTimestamp()).resolves.toBe(new Date(now).toLocaleString());
  });

  it('clears cached aid data and timestamp together', async () => {
    await cacheAidList([
      {
        id: 'aid-1',
        title: 'Food Aid',
        amount: 500,
        status: 'active',
        date: '2026-01-01',
      },
    ]);

    await clearAidCache();

    await expect(loadCachedAidList()).resolves.toBeNull();
    await expect(getCacheTimestamp()).resolves.toBeNull();
  });
});
