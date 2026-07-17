
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getItem,
  setItem,
  removeItem,
  registerSensitiveKey,
} from '../services/storage';

// Mock the storage modules
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}));

describe('Storage Service', () => {
  const SENSITIVE_KEY = '@ChainForge:AuthToken';
  const NON_SENSITIVE_KEY = '@ChainForge:SomeNonSensitiveKey';
  const TEST_VALUE = 'test-value';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses SecureStore for sensitive keys when setting', async () => {
    await setItem(SENSITIVE_KEY, TEST_VALUE);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      SENSITIVE_KEY,
      TEST_VALUE,
    );
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('uses SecureStore for sensitive keys when getting', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(TEST_VALUE);
    const result = await getItem(SENSITIVE_KEY);
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(SENSITIVE_KEY);
    expect(result).toBe(TEST_VALUE);
  });

  it('uses SecureStore for sensitive keys when removing', async () => {
    await removeItem(SENSITIVE_KEY);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(SENSITIVE_KEY);
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it('uses AsyncStorage for non-sensitive keys when setting', async () => {
    await setItem(NON_SENSITIVE_KEY, TEST_VALUE);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      NON_SENSITIVE_KEY,
      TEST_VALUE,
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('uses AsyncStorage for non-sensitive keys when getting', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(TEST_VALUE);
    const result = await getItem(NON_SENSITIVE_KEY);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(NON_SENSITIVE_KEY);
    expect(result).toBe(TEST_VALUE);
  });

  it('uses AsyncStorage for non-sensitive keys when removing', async () => {
    await removeItem(NON_SENSITIVE_KEY);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(NON_SENSITIVE_KEY);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('registers new sensitive keys and uses SecureStore for them', async () => {
    const NEW_SENSITIVE_KEY = '@ChainForge:NewSensitiveKey';
    registerSensitiveKey(NEW_SENSITIVE_KEY);

    await setItem(NEW_SENSITIVE_KEY, TEST_VALUE);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      NEW_SENSITIVE_KEY,
      TEST_VALUE,
    );
  });
});
