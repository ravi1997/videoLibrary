# User API

Base path: `/api/v1/user`
All endpoints require JWT unless noted. Admin-restricted endpoints require roles: `admin` or `superadmin`.

## Change Password
POST/PUT /api/v1/user/change-password
```json
{"current_password": "Old!Pass1", "new_password": "N3w!Pass!"}
```
200: `{ "message": "Password changed" }`

## Auth Status
GET /api/v1/user/status
Returns current user object.

## List Users (Admin)
GET /api/v1/user/users
Returns array of user summaries.

## Get User (Admin)
GET /api/v1/user/users/<user_id>

## Create User (Admin)
POST /api/v1/user/users
```json
{
  "username": "bob",
  "email": "bob@example.com",
  "mobile": "+1555000222",
  "password": "Str0ng!Pass",
  "is_verified": true
}
```
201: user object

## Update User (Admin)
PUT /api/v1/user/users/<user_id>
Partial update; skips `password_hash`.

## Delete User (Admin)
DELETE /api/v1/user/users/<user_id>

## Lock User (Admin)
POST /api/v1/user/users/<user_id>/lock

## Unlock User (Admin)
POST /api/v1/user/users/<user_id>/unlock

## Reset OTP Count (Admin)
POST /api/v1/user/users/<user_id>/reset-otp-count

## Extend Password Expiry (Admin)
POST /api/v1/user/security/extend-password-expiry
```json
{"user_id": "<uuid>", "days": 30}
```

## Lock Status (Admin)
GET /api/v1/user/security/lock-status/<user_id>
Response: `{ "locked": true|false }`

## Resend OTP (Public Endpoint w/ Rate Limit)
POST /api/v1/user/security/resend-otp
```json
{"mobile": "+1555000333"}
```
200: `{ "message": "OTP resent" }`

## Settings
### Get Settings
GET /api/v1/user/settings
Returns settings object (auto-creates defaults)

### Update Settings
PUT /api/v1/user/settings
Partial update accepted.
```json
{"theme": "dark", "autoplay": true}
```

## Notes
- Password strength enforced by model; weak passwords rejected.
- Account lock logic prevents brute forcing.
- Settings stored in `user_settings` table keyed by user id.
