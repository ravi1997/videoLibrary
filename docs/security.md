# Security Model

## Layers
1. Authentication: JWT (headers + optional cookies) with blocklist for logout.
2. Authorization: Role claims enforced via `@require_roles` decorator.
3. Input Validation: Marshmallow schemas, enum parsing, controlled field updates.
4. Rate Limiting: In-memory or Redis (recommended) via `rate_limit` decorator.
5. Transport & Headers: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
6. File Safety: Extension allowlist + MIME sniff (python-magic) + MD5 dedupe.
7. Account Protection: Password complexity, lockout, OTP attempt limits.
8. Logging & Audit: Structured JSON access logs for every request/response.

## Password Policy
Regex: at least 8 chars; upper, lower, digit, special; length ≤ 72.

## Rate Limiting Strategy
- Per-IP+path key.
- Throws 429 with retry hint.
- Swap to Redis for multi-process consistency.

## Token Revocation
- Logout stores JTI + expiry in blocklist table.
- JWT callbacks check presence in blocklist.

## Sensitive Operations
| Operation | Control |
|-----------|---------|
| Upload video | uploader/admin role + rate limit |
| Update/Delete video | Owner OR (admin/superadmin) |
| Verify user | admin/superadmin |
| Discard user | admin/superadmin, unverified only |

## Defense in Depth
- Structured logs allow anomaly detection (e.g., repeated 401s from IP).
- Ownership checks on mutable resources.
- Idempotent favorite endpoint prevents spam growth.
- Generic responses for password reset to prevent enumeration.

## Recommended Enhancements
- Add CSRF protection if relying on cookies for cross-site calls.
- Rotate secrets & enforce token TTL strategy.
- Implement refresh tokens + short-lived access tokens.
- Add anomaly alerting (failed login thresholds per IP).
- Optional: Add content hashing + integrity metadata for segments.
