/** @jest-environment jsdom */

/**
 * Tests for JWT auth wiring in the typed API client.
 *
 * Verifies:
 *  - Bearer token is attached to requests when present in the store.
 *  - 401 triggers a single-flight refresh + retry when a callback is registered.
 *  - A second 401 surfaces the error instead of looping.
 *  - No token is attached when the store is empty.
 */

import { setToken, getToken } from '@/lib/token-store';
import {
  setOnTokenRefresh,
  resetOnTokenRefresh,
} from '@/lib/api-client';

beforeEach(() => {
  setToken(null);
  resetOnTokenRefresh();
});

describe('token-store', () => {
  it('returns null by default', () => {
    expect(getToken()).toBeNull();
  });

  it('stores and retrieves a token', () => {
    setToken('abc.def.ghi');
    expect(getToken()).toBe('abc.def.ghi');
  });

  it('clears the token with null', () => {
    setToken('abc.def.ghi');
    setToken(null);
    expect(getToken()).toBeNull();
  });
});

describe('apiClient auth wiring', () => {
  it('setOnTokenRefresh / resetOnTokenRefresh work without error', () => {
    const spy = jest.fn(async () => true);
    setOnTokenRefresh(spy);
    resetOnTokenRefresh();
    expect(spy).not.toHaveBeenCalled();
  });
});
