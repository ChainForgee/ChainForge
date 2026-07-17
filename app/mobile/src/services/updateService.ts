import { VersionInfo } from '../types/update';
import { config } from '../config';
import { getItem, setItem, removeItem } from './storage';

const AUTH_TOKEN_KEY = '@ChainForge:AuthToken';
const VERSION_CONFIG_PATH = '/mobile/version';

export const getAuthToken = async (): Promise<string | null> => {
  return await getItem(AUTH_TOKEN_KEY);
};

export const setAuthToken = async (token: string): Promise<void> => {
  await setItem(AUTH_TOKEN_KEY, token);
};

export const clearAuthToken = async (): Promise<void> => {
  await removeItem(AUTH_TOKEN_KEY);
};

export const fetchVersionInfo = async (): Promise<VersionInfo> => {
  try {
    const authToken = await getAuthToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(`${config.apiUrl}${VERSION_CONFIG_PATH}`, {
      headers,
    });

    if (response.status === 401) {
      // Throw specific error for 401 to let UpdateProvider handle it
      const error = new Error('Unauthorized: Token expired');
      (error as any).status = 401;
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch version info: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('UpdateService: Error fetching version info', error);
    throw error;
  }
};

/**
 * Compares two semantic version strings.
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
export const compareVersions = (v1: string, v2: string): number => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
};
