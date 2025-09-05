# Search & Discovery API

Base path: `/api/v1/video`

## Search Endpoint
GET /api/v1/video/search

### Query Parameters
| Param | Type | Description |
|-------|------|-------------|
| q | string | Keyword (fuzzy across title, description, transcript, tags, category, surgeons) |
| category | string | Exact category name match |
| tags | string[] | Multiple tag names (repeat param) |
| duration_min | int | Minimum minutes |
| duration_max | int | Maximum minutes |
| date_from | ISO date | Created at >= date_from |
| date_to | ISO date | Created at <= date_to |
| sort | enum | `recent` (default) or `most_viewed` |
| page | int | Page number (1+) |
| per_page | int | Page size (<= 100 typical) |

### Response
```json
{
  "items": [
    {
      "uuid": "...",
      "title": "...",
      "position": 120.5,
      "duration": 600.0,
      "status": "processed",
      "category": {"id": 1, "name": "Surgery"},
      "tags": [{"id":2,"name":"Laparoscopy"}]
    }
  ],
  "page": 1,
  "per_page": 12,
  "pages": 4,
  "total": 48
}
```
`position` is watch progress for current user (0 if none).

### Filtering Logic
- Duration converted from minutes → seconds internally.
- Tags combined with OR logic among provided tag names.
- Keyword `q` matches any joined entity (video + tag + category + surgeon).

### Performance Tips
- Add composite indexes on frequently filtered columns in production (e.g., status, created_at, views).
- Consider full‑text search (PostgreSQL `tsvector`) for transcript scaling.

## Recommendations
GET /api/v1/video/<uuid>/recommendations
- Tag-based match; fallback to same category.
- Limit: 12 items.

## Watch Next
GET /api/v1/video/<uuid>/watch-next
- Provides up to 3 related items.

## Trending
GET /api/v1/video/trending
- Sorted by views desc; paginated (default 10 per page).
