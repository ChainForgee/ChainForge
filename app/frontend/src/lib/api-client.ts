import createClient from 'openapi-fetch';
import type { paths } from './generated/api';
import { fetchClient } from './mock-api/client';
import { apiUrl } from './env';
import { withTimeoutFetch } from './fetch-timeout';
import { getToken, setToken } from './token-store';

/**
 * Callback invoked when the client receives a 401 and the token has
 * expired.  The caller should refresh the token (e.g. via an OIDC
 * token-refresh call) and push the new token via `setToken`.
 * Return `true` if a new token was obtained; `false` to surface the
 * 401 as an auth error to the caller.
 */
export type OnTokenRefresh = () => Promise<boolean>;

let _onTokenRefresh: OnTokenRefresh | null = null;

/** Register a single-flight token-refresh callback. */
export const setOnTokenRefresh = (fn: OnTokenRefresh | null): void => {
  _onTokenRefresh = fn;
};

/** Reset the refresh callback (useful in tests). */
export const resetOnTokenRefresh = (): void => {
  _onTokenRefresh = null;
};

/**
 * Token-aware fetch wrapper.
 *
 * Attaches `Authorization: Bearer <token>` to every request when a token
 * is available.  On 401, if a refresh callback is registered it is called
 * **once** and the request is retried with the new token.  A second 401
 * is surfaced as an auth error.
 */
const authFetch: typeof fetch = async (input, init) => {
  const token = getToken();

  const authHeaders = new Headers(init?.headers as HeadersInit | undefined);
  if (token) {
    authHeaders.set('Authorization', `Bearer ${token}`);
  }

  const response = await withTimeoutFetch(fetchClient as typeof fetch)(
    input,
    { ...init, headers: authHeaders } as RequestInit,
  );

  if (response.status === 401 && _onTokenRefresh) {
    const refreshed = await _onTokenRefresh();
    if (refreshed) {
      const newToken = getToken();
      const retryHeaders = new Headers(init?.headers as HeadersInit | undefined);
      if (newToken) {
        retryHeaders.set('Authorization', `Bearer ${newToken}`);
      }
      return withTimeoutFetch(fetchClient as typeof fetch)(
        input,
        { ...init, headers: retryHeaders } as RequestInit,
      );
    }
  }

  return response;
};

/**
 * Typed API client for the ChainForge backend.
 *
 * - Types are generated from openapi.json via `pnpm generate:api`.
 * - Requests are routed through fetchClient so mock interception
 *   (NEXT_PUBLIC_USE_MOCKS=true) works transparently.
 * - Auth: the backend uses JWT bearer tokens.  Call `setToken()` to
 *   push a fresh token and `setOnTokenRefresh()` to register a
 *   single-flight refresh callback for 401s.
 */
export const apiClient = createClient<paths>({
  baseUrl: apiUrl,
  fetch: authFetch as typeof fetch,
});
