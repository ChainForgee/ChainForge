
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Sensitive keys (use SecureStore)
const SENSITIVE_KEYS = new Set<string>([
  '@ChainForge:AuthToken', // from updateService
]);

// Helper to check if a key is sensitive
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/**
 * Get an item from storage.
 * Uses SecureStore for sensitive keys, AsyncStorage otherwise.
 */
export async function getItem(key: string): Promise<string | null> {
  if (isSensitiveKey(key)) {
    return await SecureStore.getItemAsync(key);
  } else {
    return await AsyncStorage.getItem(key);
  }
}

/**
 * Set an item in storage.
 * Uses SecureStore for sensitive keys, AsyncStorage otherwise.
 */
export async function setItem(key: string, value: string): Promise<void> {
  if (isSensitiveKey(key)) {
    await SecureStore.setItemAsync(key, value);
  } else {
    await AsyncStorage.setItem(key, value);
  }
}

/**
 * Remove an item from storage.
 * Uses SecureStore for sensitive keys, AsyncStorage otherwise.
 */
export async function removeItem(key: string): Promise<void> {
  if (isSensitiveKey(key)) {
    await SecureStore.deleteItemAsync(key);
  } else {
    await AsyncStorage.removeItem(key);
  }
}

/**
 * Clear all storage (use carefully).
 */
export async function clear(): Promise<void> {
  // Clear AsyncStorage
  await AsyncStorage.clear();
  // Clear sensitive keys
  for (const key of SENSITIVE_KEYS) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch (e) {
      // Ignore errors when clearing
    }
  }
}

// Add more sensitive keys as needed
export function registerSensitiveKey(key: string): void {
  SENSITIVE_KEYS.add(key);
}
