# API Overview

All endpoints are versioned under `/api/v1`. JSON is the default content type. Authentication uses JWT Access Tokens (header Authorization: Bearer <token>) and secure cookies (if enabled).

## Conventions
- `uuid` refers to a video UUID (string)
- Timestamps are ISO 8601 UTC
- Pagination: `page`, `per_page` query params; responses include `page`, `per_page`, `total`, `pages`
- Rate limiting returns HTTP 429 with payload `{ "error": "rate_limited", "retry_after": <seconds> }`
- Errors use consistent JSON `{ "error"|"msg": <string>, ... }`

## Authentication Summary
| Flow | Endpoint | Notes |
|------|----------|-------|
| Register | POST /auth/register | Self‑registration (limited roles) |
| Login | POST /auth/login | Password or OTP (mobile) |
| OTP Generate | POST /auth/generate-otp | Sends OTP to mobile |
| OTP Verify | POST /auth/verify-otp | Verifies sent code |
| Forgot Password | POST /auth/forgot-password | Issues reset token |
| Reset Password | POST /auth/reset-password | Completes password reset |
| Logout | POST /auth/logout | Revokes current token |

Full details in `auth.md`.
