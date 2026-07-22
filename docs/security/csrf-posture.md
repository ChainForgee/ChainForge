# CSRF Posture

## Current Posture (Disabled by Default)

ChainForge uses stateless, API-key-based authentication via the `x-api-key`
custom HTTP header. Browsers never auto-attach custom headers on
cross-origin requests, so **CSRF attacks are inherently prevented** under
the current architecture.

There is no `cookie-parser` middleware installed and no browser-managed
credentials (cookies, session storage) are used for authentication.

## When Would CSRF Become a Risk?

CSRF protection **must** be enabled if any of the following changes are
introduced:

- Cookie-based session management (e.g., `SameSite=None; Secure` cookies)
- OAuth / OIDC flows that store tokens in cookies
- Any `Set-Cookie` header that carries authentication state
- Third-party embeds that rely on cookie-based credentials

Adding `cookie-parser` without enabling CSRF protection is a silent
regression.

## Double-Submit Cookie Middleware

A `CsrfMiddleware` is available behind the `CSRF_PROTECTION_ENABLED`
feature flag. It implements the **double-submit cookie** pattern:

1. **On safe methods** (`GET`, `HEAD`, `OPTIONS`, `TRACE`): the middleware
   issues a cryptographically random token in a `_csrf_token` cookie
   (SameSite=strict, 1-hour expiry).

2. **On unsafe methods** (`POST`, `PUT`, `PATCH`, `DELETE`): the
   middleware requires the same token to be echoed back in the
   `x-csrf-token` request header. A constant-time comparison prevents
   timing attacks.

No server-side session store is required.

## Enabling CSRF Protection

Set the environment variable:

```bash
CSRF_PROTECTION_ENABLED=true
```

The middleware is registered in `main.ts` only when this flag is truthy.

## Client Integration

When enabled, the client must:

1. Read the `_csrf_token` cookie from the response (JavaScript-accessible,
   not `httpOnly`).
2. Include it as the `x-csrf-token` header on every unsafe request.

Example (fetch):

```ts
function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

await fetch('/api/v1/resource', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-csrf-token': getCsrfToken(),
  },
  body: JSON.stringify({ ... }),
});
```

## Test Coverage

- `csrf.middleware.spec.ts` — unit tests verifying:
  - Safe methods receive a CSRF cookie
  - Existing cookies are not overwritten
  - Unsafe methods reject missing tokens
  - Unsafe methods reject mismatched tokens
  - Unsafe methods accept matching tokens
  - Constant-time comparison (timing-safe)

## References

- [OWASP: Cross-Site Request Forgery](https://owasp.org/www-community/attacks/csrf)
- [OWASP: Double Submit Cookie](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#double-submit-cookie)
