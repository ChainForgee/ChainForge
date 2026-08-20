/**
 * Minimal token store for JWT authentication.
 *
 * The store is intentionally decoupled from any auth provider so that any
 * caller (NextAuth session callback, OIDC token-refresh, etc.) can push
 * a fresh token and the api-client picks it up on the next request.
 */

let _token: string | null = null;

/** Push a fresh JWT into the store. */
export const setToken = (token: string | null): void => {
  _token = token;
};

/** Read the current token (may be null when unauthenticated). */
export const getToken = (): string | null => _token;
