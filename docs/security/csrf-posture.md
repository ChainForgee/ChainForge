# CSRF Protection Posture

## Current Status

**CSRF attacks are NOT currently exploitable.**

ChainForge uses a stateless, API-key-based authentication mechanism where credentials
are sent via a custom HTTP header (`x-api-key` / `Authorization`). Browsers do NOT
automatically attach custom headers on cross-origin requests, so the traditional
CSRF attack vector (where the browser auto-attaches cookies) does not apply.

## Threat Model

| Attack vector | Mitigated? | Why |
|---|---|---|
| Traditional CSRF (cookie-based) | ✅ Yes | No cookies used for auth |
| Custom-header-based CSRF | ✅ Yes | Browsers cannot auto-attach `x-api-key` |
| Same-origin form CSRF | ✅ Yes | Requires cookie-based auth |
| XSS + CSRF combined | ⚠️ Partial | CSRF middleware cannot prevent XSS (separate concern) |

## When CSRF Protection Becomes Necessary

If the following conditions are met, the CSRF middleware MUST be enabled:

1. Cookie-based session management is introduced (e.g., `Set-Cookie` with `sessionId`)
2. Any browser-managed credential flow is added (e.g., OAuth2 implicit grant, cookie-based tokens)
3. `SameSite=None; Secure` cookies are deployed alongside cross-origin API calls
4. `cookie-parser` or similar cookie middleware is added to the Express/NestJS pipeline

## Implementation

CSRF protection is implemented via a **double-submit-cookie** pattern
in `src/common/security/csrf.middleware.ts`:

- **Disabled by default** — gated behind `CSRF_PROTECTION_ENABLED=true` env variable
- **Safe methods** (GET, HEAD, OPTIONS) — a random CSRF token is set as a cookie
- **State-changing methods** (POST, PUT, PATCH, DELETE) — the middleware validates that
  the `csrf-token` cookie matches the `X-CSRF-Token` request header
- **Token rotation** — the token is rotated after each state-changing request for forward secrecy
- **Constant-time comparison** — prevents timing attacks on token validation

## Testing

| Scenario | Expected Result |
|---|---|
| `CSRF_PROTECTION_ENABLED=false` (default) | CSRF bypassed, no validation |
| `CSRF_PROTECTION_ENABLED=true`, valid token | Request succeeds |
| `CSRF_PROTECTION_ENABLED=true`, missing cookie | 403 Forbidden |
| `CSRF_PROTECTION_ENABLED=true`, missing header | 403 Forbidden |
| `CSRF_PROTECTION_ENABLED=true`, mismatched tokens | 403 Forbidden |
| `CSRF_PROTECTION_ENABLED=true`, GET request | Token set, no validation |

## Running the CSRF-Enabled Test

```bash
CSRF_PROTECTION_ENABLED=true npx jest --testPathPattern=csrf.middleware.spec
```

## Future Considerations

- If `cookie-parser` is added to the NestJS pipeline, the `req.cookies` access in
  the middleware will work natively without changes.
- For Single-Page-Application (SPA) flows, the token should be obtained from the
  initial GET response (as a cookie) and included in subsequent fetch/XMLHttpRequest
  calls via the `X-CSRF-Token` header.
- The double-submit-cookie pattern was chosen over `csurf`/`csrf-csrf` packages to
  keep the dependency surface minimal (~30 lines of middleware).
