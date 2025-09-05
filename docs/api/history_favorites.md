# History & Favorites API

Base path: `/api/v1/video`

## Save Progress
POST /api/v1/video/progress
```json
{"video_id": "<uuid>", "position": 123.45}
```
200: `{ "message": "Progress saved", "position": 123.45 }`

## Get Progress
GET /api/v1/video/progress/<uuid>
Returns `{ "position": <float> }` (0 if none).

## Latest History
GET /api/v1/video/history/latest
Returns up to 10 most recently watched with metadata.

## Paginated History
GET /api/v1/video/history?sort=recent|alpha|progress&page=1&page_size=12
Response includes:
```json
{
  "items": [
    {"uuid": "...", "position": 120, "duration": 600, "progress_pct": 20}
  ],
  "count": 42,
  "page": 1,
  "pages": 4,
  "total_watched_sec": 9000
}
```

## Delete Single History Item
DELETE /api/v1/video/history/<uuid>
Idempotent; returns removed count.

## Clear All History
DELETE /api/v1/video/history

## Favorites
### List Favorites
GET /api/v1/video/favorite?sort=recent|alpha&page=1&per_page=12

### Favorite Status
GET /api/v1/video/<uuid>/favorite
```json
{"favorite": true|false}
```

### Add Favorite
POST /api/v1/video/<uuid>/favorite
Idempotent; duplicate adds return `{ "ok": true, "already": true }`

### Remove Favorite
DELETE /api/v1/video/<uuid>/favorite

## Stats
GET /api/v1/video/stats
```json
{"favorites": 5, "watched": 37}
```

## Data Integrity Notes
- Progress upsert ensures single row per (user_id, video_id).
- History derived from `video_progress` table timestamps.
- Favorites uniqueness enforced via application logic (could add DB unique constraint for scale).
