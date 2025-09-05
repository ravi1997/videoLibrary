# Settings API

Base path: `/api/v1/user/settings`

## Get Settings
GET /api/v1/user/settings
Response example:
```json
{
  "user_id": "<uuid>",
  "theme": "system",
  "compact": false,
  "autoplay": false,
  "quality": "auto",
  "speed": "1.0",
  "email_updates": false,
  "weekly_digest": false,
  "private_profile": false,
  "personalize": true,
  "updated_at": "2025-09-05T12:34:56.000000"
}
```

## Update Settings
PUT /api/v1/user/settings
Partial JSON accepted:
```json
{"theme": "dark", "quality": "1080p", "autoplay": true}
```
200 returns updated object.

## Fields
| Field | Type | Description |
|-------|------|-------------|
| theme | enum(light,dark,system) | UI color scheme |
| compact | bool | Dense layout flag |
| autoplay | bool | Auto-play next video |
| quality | enum | Preferred quality (auto, 480p, 720p, 1080p, 2160p) |
| speed | string | Playback speed ("1.0", etc.) |
| email_updates | bool | Marketing/feature emails |
| weekly_digest | bool | Weekly summary toggle |
| private_profile | bool | Hide profile from public listings |
| personalize | bool | Allow personalized recommendations |

## Behavior
- Missing record auto-created with defaults.
- Unknown fields ignored.
- Validation errors produce 400 with details.
