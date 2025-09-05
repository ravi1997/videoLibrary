# Video API

Base path: `/api/v1/video`
All routes protected by JWT. Creation & modification require roles: `uploader` or `admin` (or superadmin).

## Upload Raw Video
POST /api/v1/video/upload  (multipart/form-data)
Field: `file`
Extensions allowed: .mp4 .mov .mkv .avi
Size limit: 500 MB
Rate limited (10/hour per IP+path)
Response 201:
```json
{"uuid": "<video_uuid>", "status": "pending"}
```
If duplicate MD5:
```json
{"uuid": "<existing_uuid>", "status": "processed"}
```

## Create / Update Metadata After Upload
POST /api/v1/video/
```json
{
  "uuid": "<video_uuid>",
  "title": "Laparoscopic Procedure",
  "description": "Step by step demo",
  "transcript": "...",
  "category": {"name": "Surgery"},
  "tags": [{"name": "laparoscopy"}, {"name": "training"}],
  "surgeons": [{"name": "Dr. Smith", "type": "lead"}]
}
```
200 returns full serialized metadata.

## Get Video Metadata
GET /api/v1/video/<uuid>

## Recommendations
GET /api/v1/video/<uuid>/recommendations
Tag-based; falls back to same category.

## Watch Next
GET /api/v1/video/<uuid>/watch-next
Up to 3 related.

## List Videos
GET /api/v1/video/
Query Params:
`category`, `status`, `tags` (multi), `user_id`, `sort` (trending|recent|most_viewed), `page`, `per_page`

## Trending
GET /api/v1/video/trending

## Categories / Tags / Surgeons
GET /api/v1/video/categories
GET /api/v1/video/tags
GET /api/v1/video/tags/top?limit=5
GET /api/v1/video/surgeons
GET /api/v1/video/surgeons/paginated?page=1&per_page=20
GET /api/v1/video/surgeons/<id>

## Channel Info
GET /api/v1/video/channels/<user_id>
Returns user summary + video count.

## Update Video
PUT /api/v1/video/<uuid>
Fields: title, description, transcript, status, category_id, tag_ids[], surgeon_ids[]
Owner or admin only.

## Delete Video
DELETE /api/v1/video/<uuid>
Owner or admin only.

## HLS Playback
GET /api/v1/video/hls/<uuid>/master.m3u8
GET /api/v1/video/hls/<uuid>/<asset>
Serves master and encrypted segments/keys. (Currently JWT-gated.)

### Public Playback (Optional)
If `ALLOW_PUBLIC_PLAYBACK=true` in environment:
```
GET /api/v1/video/public/hls/<uuid>/master.m3u8
GET /api/v1/video/public/hls/<uuid>/<asset>
```
Only videos with status `processed` or `published` are exposed; others return 403/404.

## Thumbnails
GET /api/v1/video/thumbnails/<uuid>.jpg

## Progress & History
GET /api/v1/video/progress/<uuid>
POST /api/v1/video/progress `{ "video_id": "<uuid>", "position": 123.45 }`

GET /api/v1/video/history (pagination + sorting)
GET /api/v1/video/history/latest
DELETE /api/v1/video/history/<uuid>
DELETE /api/v1/video/history (clear all)

## Favorites
GET /api/v1/video/favorite (paginated)
GET /api/v1/video/<uuid>/favorite (status)
POST /api/v1/video/<uuid>/favorite
DELETE /api/v1/video/<uuid>/favorite

## Search
GET /api/v1/video/search
Query Params:
`q`, `category`, `tags` (multi), `duration_min`, `duration_max`, `date_from`, `date_to`, `sort` (recent|most_viewed), `page`, `per_page`.
Response includes embedded `position` if user progress exists.

## Stats (User)
GET /api/v1/video/stats
Returns `{ "favorites": <int>, "watched": <int> }`.

## Analytics (Placeholder)
POST /api/v1/video/analytics
Body any JSON; returns `{ "ok": true }`.

## Status Codes
| Code | Meaning |
|------|---------|
| 200 | Success / retrieval |
| 201 | Created (upload, view/like placeholder) |
| 400 | Invalid input (enums, pagination) |
| 401 | Missing/invalid JWT |
| 403 | Ownership / role violation |
| 404 | Not found (video/playlist/segment) |
| 429 | Rate limited |
| 500 | Internal error |

## Security Notes
- Video ownership enforced on update/delete
- MIME sniff & extension whitelist on upload
- Duplicate favorites suppressed idempotently
- All endpoints require JWT (adjust for public streaming if needed)
