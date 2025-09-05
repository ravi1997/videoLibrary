# Authentication & Authorization API

Base path: `/api/v1/auth`

## 1. Register
POST /api/v1/auth/register
Requests self-registration with limited roles (viewer/general). Admin / elevated roles must be assigned separately.

Request JSON:
```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "Str0ng!Pass",
  "mobile": "+1555000111",
  "employee_id": "EMP1234",
  "roles": ["viewer", "user"]
}
```
Response 201:
```json
{"message": "User registered"}
```
Conflicts (409) for duplicate email/employee id.

## 2. Login
POST /api/v1/auth/login
Supports password OR OTP flow.

Password flow request:
```json
{"email": "alice@example.com", "password": "Str0ng!Pass"}
```
OTP flow request:
```json
{"mobile": "+1555000111", "otp": "123456"}
```
Success 200:
```json
{
  "access_token": "<jwt>",
  "success": true
}
```
JWT contains `sub` (user id) + `roles` claim.

## 3. Generate OTP
POST /api/v1/auth/generate-otp
```json
{"mobile": "+1555000111"}
```
200:
```json
{"msg": "OTP sent successfully", "success": true}
```

## 4. Verify OTP
POST /api/v1/auth/verify-otp
```json
{"mobile": "+1555000111", "otp": "123456"}
```
200: `{ "msg": "otp verified", "mobile": "+1555000111" }`

## 5. Employee / Mobile Lookup
POST /api/v1/auth/employee-lookup
Flexible on-boarding (employee id, mobile). Returns provisional or existing record, defers OTP sending.

## 6. Create Account (Finalize)
POST /api/v1/auth/create-account
Finalize provisional user after OTP verify.
```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "Str0ng!Pass",
  "mobile": "+1555000111",
  "employee_id": "EMP1234",
  "temp_upload_id": "<id>"
}
```

## 7. Upload Temp ID Document
POST /api/v1/auth/upload-temp-id (multipart form)
Field: `file`
Response:
```json
{"msg": "temp file stored", "temp_upload_id": "abc123", "filename": "id.pdf"}
```

## 8. Upload ID (Post Account)
POST /api/v1/auth/upload-id/<user_id> (multipart form)
Marks `document_submitted` true.

## 9. Admin: List Unverified
GET /api/v1/auth/unverified (roles: admin/superadmin)
Response:
```json
{"users": [{"id": "..", "username": ".."}], "count": 1}
```

## 10. Admin: Verify User
POST /api/v1/auth/verify-user
```json
{"user_id": "<uuid>"}
```

## 11. Admin: Fetch User Document
GET /api/v1/auth/user-document/<user_id>
Streams first matching document or 404.

## 12. Admin: Discard User
POST /api/v1/auth/discard-user
```json
{"user_id": "<uuid>"}
```
Removes unverified user + documents.

## 13. Logout
POST /api/v1/auth/logout (JWT required)
Revokes token (blocklist) and clears cookies.

## 14. Me
GET /api/v1/auth/me (JWT)
Returns serialized user.

## 15. Forgot Password
POST /api/v1/auth/forgot-password
```json
{"email": "alice@example.com"}
```
Always returns generic success (enumeration safe).

## 16. Reset Password
POST /api/v1/auth/reset-password
```json
{"email": "alice@example.com", "token": "abcd1234", "password": "N3w!Pass"}
```

## Error Codes & Notes
| Code | Reason |
|------|--------|
| 400 | Missing / invalid fields |
| 401 | Invalid credentials / OTP |
| 403 | Not verified / locked |
| 404 | User not found |
| 409 | Duplicate resource |

## Security Notes
- Password policy enforced in model (complexity & length)
- Rate limits on register/login/OTP endpoints
- Token revocation stored using blocklist model
