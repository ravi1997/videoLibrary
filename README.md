

npm install tailwindcss @tailwindcss/cli


```css
/* static/src/input.css */
@import "tailwindcss" source(none);

@source "../../templates/**/*.html";
/* Tell Tailwind what to watch/scan  for changes */
```


https://tailwindcss.com/docs/detecting-classes-in-source-files#explicitly-registering-sources




npx @tailwindcss/cli -i ./app/static/css/input.css -o ./app/static/css/output.css --watch

## Backend Setup & Run

```bash
# One-time environment & dependency setup
bash scripts/setup_env.sh

# Run in development mode
MODE=dev bash scripts/start_app.sh

# Run with Gunicorn (production style)
MODE=prod PORT=8000 WORKERS=4 LOG_LEVEL=info bash scripts/start_app.sh
```
<div align="center">
	<h1>Video Library Platform</h1>
	<p>A secure, role-based, HLS streaming & video management backend built with Flask, SQLAlchemy & JWT.</p>
</div>

---

## 1. Overview
This project provides a production-grade backend for uploading, transcoding, securing, and streaming videos (HLS with AES-128 segment encryption). It includes:

* Role-Based Access Control (RBAC) with fine-grained JWT claims
* Video upload + background HLS multi-variant (resolution ladder) generation
* AES-128 encryption for HLS segments (per-variant keys)
* Playback history + resume progress
* Favorites / user personalization
* Rich search with filters (tags, surgeons, category, duration ranges, dates)
* Structured JSON logging & security headers (CSP, X-Frame-Options, etc.)
* Rate limiting (in‑memory or Redis-backed) for abuse protection
* Password complexity enforcement & account lockout
* OTP support foundations (model fields + verification logic)
* Thumbnail extraction via FFmpeg
* Extensible tagging, categorization, and surgeon metadata linking

---

## 2. Core Technologies
| Area | Stack |
|------|-------|
| Framework | Flask (Blueprint modular routing) |
| Data Layer | SQLAlchemy + Alembic migrations; SQLite (default) or any RDBMS |
| Auth | flask-jwt-extended with custom claims + blocklist |
| Transcoding | FFmpeg + worker thread queue (app.tasks) |
| Serialization | Marshmallow schemas |
| Rate Limiting | Custom decorator (memory / Redis) in security_utils.py |
| Logging | Structured (orjson fallback) + rotating file handler |
| Styling (optional) | Tailwind CSS (CLI build) |
| Compression & CORS | flask-compress, flask-cors |

---

## 3. Features & Flow
### Upload & Transcode
1. Authenticated uploader hits `POST /api/v1/video/upload` with a raw file (mp4/mov/mkv/avi).
2. File stored, DB row created in `pending` status (MD5 dedupe enforced).
3. Background worker converts to multiple HLS variants (≤ source resolution) with AES-128 encrypted segments.
4. Master playlist saved at: `app/static/hls_output/<video_uuid>/master.m3u8`.
5. Status updated to `processed` (or `failed`).
6. Thumbnail extracted to `app/static/thumbnails/<uuid>.jpg`.

### Playback & History
* HLS master: `/api/v1/video/hls/<uuid>/master.m3u8` (JWT protected).
* Segments/keys: `/api/v1/video/hls/<uuid>/<asset>`.
* Progress save: `POST /api/v1/video/progress`.
* Recent history & aggregated stats endpoints.

### Discovery & Personalization
* Filtering: category, tags, status, uploader.
* Search: multi-field partial match (title, description, transcript, tags, category, surgeons).
* Favorites: idempotent add/remove with state check endpoint.

### Security & Resilience
* All routes protected with JWT (adjust if public streaming needed).
* Role enforcement via `@require_roles`.
* Rate limiting on sensitive endpoints (upload/metadata creation).
* Password policy + account lockout + OTP attempts control.
* Security headers (CSP, X-Frame-Options, X-Content-Type-Options, etc.).
* Upload validation: size, extension, MIME sniff (python-magic), MD5 duplicate suppression.

---

## 4. Repository Layout
```
app/
	__init__.py          # App factory (logging, headers, worker startup)
	config.py            # Environment configuration
	extensions.py        # Flask extension instances
	models/              # SQLAlchemy models & enums
	routes/              # Versioned blueprints (v1)
	schemas/             # Marshmallow schemas
	tasks.py             # HLS conversion & thumbnail logic
	security_utils.py    # Rate limiting, password strength, structured logging
	utils/               # Decorators & helpers
	static/              # Thumbnails, HLS output, assets
	templates/           # Jinja templates (if using server-rendered views)
scripts/               # setup & run scripts
tests/                 # Pytest suites
migrations/            # Alembic migrations
```

---

## 5. Prerequisites
* Python 3.12+
* FFmpeg & OpenSSL installed
* (Optional) Redis (recommended for production rate limiting)
* (Optional) Node.js (if building Tailwind)

Install FFmpeg (Ubuntu):
```bash
sudo apt update && sudo apt install -y ffmpeg openssl
```

Install Redis (optional):
```bash
sudo apt install -y redis-server
```

---

## 6. Quick Start
```bash
# One-time setup
bash scripts/setup_env.sh

# Development
MODE=dev bash scripts/start_app.sh

# Production style (Gunicorn)
MODE=prod PORT=8000 WORKERS=4 LOG_LEVEL=info bash scripts/start_app.sh
```
Default bind: `http://127.0.0.1:5000`.

---

## 7. Environment Variables
| Variable | Purpose | Default |
|----------|---------|---------|
| SECRET_KEY | Flask session crypto | generated / placeholder |
| JWT_SECRET_KEY | JWT signing | generated / placeholder |
| DATABASE_URI | SQLAlchemy DSN | sqlite:///app.db |
| REDIS_URL | Redis DSN for rate limit | (unset) |
| HOST / PORT | Bind address/port | 127.0.0.1 / 5000 |
| WORKERS | Gunicorn workers | 2 |
| LOG_LEVEL | Gunicorn log level | info |

The `setup_env.sh` script creates `.env` with secrets if missing.

---

## 8. Authentication & Authorization
* JWT tokens issued by auth routes (see `routes/v1/auth_route.py`).
* Claims include `roles`; decorator `@require_roles` enforces RBAC.
* All video endpoints: JWT required (including HLS). If you need public playback, remove decorators from HLS routes.
* Account lockouts & password expiration handled in `User` model.
* Case-insensitive login for email / username / employee_id (normalized to lowercase before matching) to reduce user friction.
* Dual-mode login: password or mobile+OTP. OTP flow rate-limited (see below) and requires prior OTP generation.

### Password Policy
Regex (in `security_utils.py`): at least 8 chars, upper, lower, digit, special char.

### Lockout Logic
* 5 failed logins → 24h lock.
* OTP resend count also triggers lock when exceeded.

---

## 9. Rate Limiting
Decorator form:
```python
@rate_limit(ip_and_path_key, limit=10, window_sec=3600)
```
* Memory store (dev) or Redis (prod) using `REDIS_URL`.
* Returns 429 with JSON including `retry_after`.

Programmatic helper (fine-grained limiting inside a function):
```python
from app.security_utils import allow_action
allowed, retry_after = allow_action(f"otp:{mobile}", limit=6, window_sec=300)
if not allowed:
	return jsonify({"msg": "Too many attempts", "retry_after": retry_after}), 429
```
Used for OTP verification attempts: max 6 per 5 minutes per mobile number.

---

## 10. HLS Pipeline
1. Upload raw file.
2. Queue entry created (`enqueue_transcode`).
3. Worker thread scales/encodes multiple variants ≤ original resolution.
4. Segments encrypted (AES-128-CBC) with per-variant key.
5. Variant playlists + master playlist assembled.
6. Video status moved to `processed` or `failed`.

Directory example:
```
app/static/hls_output/<video_uuid>/
	master.m3u8
	1080p/segments/enc_segment_000.ts
	1080p/keys/key.key
	1080p/1080p.m3u8
```
Modify ladder in `tasks.convert_to_hls`.

---

## 11. Logging & Security Headers
* Rotating file logs in `logs/app.log` + stdout.
* Structured events via `log_structured` (JSON). 
* Automatic headers: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.

---

## 12. Testing
Run:
```bash
pytest -q
```
Included tests: security basics, extended RBAC/rate limit/favorites ownership. Extend for: upload success path, HLS manifest validation, search filters.

Suggested new tests (recent changes):
* Case-insensitive login (e.g., EMAIL@example.com).
* OTP attempt exhaustion returns 429 with retry_after.
* Presence of new DB indexes (reflection-based check of AuditLog & Video tables).

---

## 13. Tailwind CSS (Optional)
Install:
```bash
npm install tailwindcss @tailwindcss/cli --save-dev
```
Example input (`app/static/css/input.css`):
```css
@import "tailwindcss" source(none);
@source "../../templates/**/*.html";
```
Build & watch:
```bash
npx @tailwindcss/cli -i ./app/static/css/input.css -o ./app/static/css/output.css --watch
```

---

## 14. Deployment
Gunicorn example:
```bash
MODE=prod HOST=0.0.0.0 PORT=8000 WORKERS=4 bash scripts/start_app.sh
```
Nginx snippet:
```
location /api/ {
	proxy_pass http://127.0.0.1:8000;
	proxy_set_header Host $host;
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /static/ { root /path/to/project/app; }
```
Hardening checklist:
* Enable HTTPS (TLS)
* Use Redis for rate limiting
* Rotate `SECRET_KEY` & `JWT_SECRET_KEY`
* External log shipping
* Optional: WAF / CDN shielding

---

## 15. Troubleshooting
| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| Upload 500 | Permissions / invalid file | Check `app/uploads` & logs |
| HLS 404 | Transcode not finished | Wait / check worker logs |
| 429 errors | Rate limit exceeded | Respect `retry_after` |
| Password rejected | Policy failure | Add upper/lower/digit/special |
| Duplicate upload returns existing UUID | MD5 match | Use returned UUID |

Logs: see `logs/app.log`.

---

## 16. Extensibility Ideas
* WebSocket or SSE for transcode completion
* Object storage (S3) for media & thumbnails
* ML-based recommendations (embedding similarity)
* Analytics pipeline (event streaming to Kafka / ClickHouse)
* Scheduled secret rotation & audit trail persistence

---

## 17. API (Selected Endpoints)
| Method | Path | Purpose | Auth | Roles |
|--------|------|---------|------|-------|
| POST | /api/v1/video/upload | Upload raw video | JWT | uploader/admin |
| POST | /api/v1/video/ | Update metadata for uploaded file | JWT | uploader/admin |
| GET | /api/v1/video/<id> | Video metadata | JWT | any |
| GET | /api/v1/video/hls/<id>/master.m3u8 | Master playlist | JWT | any |
| GET | /api/v1/video/hls/<id>/<asset> | Segments/keys | JWT | any |
| POST | /api/v1/video/progress | Save progress | JWT | any |
| GET | /api/v1/video/favorite | List favorites | JWT | any |
| POST | /api/v1/video/<id>/favorite | Add favorite | JWT | any |
| DELETE | /api/v1/video/<id>/favorite | Remove favorite | JWT | any |
| GET | /api/v1/video/search | Advanced search | JWT | any |

Explore `app/routes/v1/` for full set.

---

## 18. Contributing Workflow
1. Branch: `feat/<slug>`
2. Add tests for new behavior
3. Run `pytest -q`
4. Submit PR with security impact notes

---

## 19. Maintenance Checklist
* Alembic migrations on model change
* Quarterly secret rotation
* Dependency audit monthly
* Log review & anomaly detection
* Backup verification
* Rebuild / verify DB indexes after major upgrades

---

## 20. License
Specify license (MIT/Apache/Proprietary). Currently unspecified.

---

## 21. Acknowledgements
* Flask, SQLAlchemy, Marshmallow
* FFmpeg Community
* Tailwind CSS

---

Happy building! Open issues for enhancement requests.

---

## 22. Superadmin Audit API
Two related endpoints provide cursor & filterable access to audit logs.

### GET /api/v1/super/audit/list
Returns a page of audit events using cursor-based pagination.

Query Parameters:
- event: exact event name filter (optional)
- user_id: actor user id (optional)
- target_user_id: target user id (optional)
- start_date / end_date: ISO date (YYYY-MM-DD). end_date is exclusive internally (+1 day). Mutually usable with epoch params.
- start_ts / end_ts: Unix epoch seconds (overrides date forms if supplied)
- last_id: cursor (id of last item from previous page). For order=desc returns earlier (smaller) ids; for order=asc returns newer (larger) ids.
- limit: results per page (1–200; default 50)
- order: desc (default) or asc

Response:
```
{
	"items": [ { id, event, user_id, target_user_id, detail, created_at, ... }, ... ],
	"limit": 50,
	"next_cursor": 1234,    // omit/null if no more
	"has_more": true,
	"order": "desc"
}
```

Errors:
- 400 invalid_start_date | invalid_end_date | end_before_start | range_too_large

Range Limits:
- Maximum span when both start & end provided: 62 days.

### GET /api/v1/super/audit/export
Filtered export (JSON) of recent audit events.

Query Parameters (subset mirrors list):
- event, user_id, target_user_id
- start_date / end_date or start_ts / end_ts (same parsing & validation rules)
- limit (1–2000; default 500)

Notes:
- Always returns newest first (descending id) currently.
- Use list endpoint for pagination; export is for point-in-time snapshots / offline analysis.

Example:
```
/api/v1/super/audit/list?event=login_failed&start_date=2025-09-01&end_date=2025-09-06&limit=100
```

Frontend Behavior:
- Cursor stored as next_cursor; client sends last_id=next_cursor for subsequent pages.
- When switching filters, reset cursor.

---

## 23. Recent Security & Performance Enhancements
Summary of latest hardening & optimization work:

| Area | Change | Impact |
|------|--------|--------|
| Login | Case-insensitive matching on email/username/employee_id | Reduces duplicate accounts / user friction |
| OTP | Programmatic rate limit: 6 attempts / 5 min per mobile (`allow_action`) | Slows brute-force attacks |
| Rate Limiting | Added `allow_action(key, limit, window_sec)` helper | Enables granular, contextual throttling beyond decorators |
| Audit Logs | Composite indexes `(event, created_at)`, `(user_id, created_at)` | Faster filtered + time-sliced queries |
| Videos | Composite indexes `(user_id, created_at)`, `(status, created_at)` | Quicker dashboard & moderation listings |
| Audit Helper | `audit_log` now accepts `user_id` (alias of legacy `actor_id`) | Clearer semantics, backward compatible |

### Applying New Index Migrations
If updating an existing deployment pull the latest code then run:
```bash
flask db upgrade
```
This creates the new composite indexes without destructive changes.

### OTP Flow (End-to-End)
1. Client requests `/api/v1/auth/generate-otp` with mobile.
2. User receives 6-digit code (valid 5 minutes).
3. Client submits `/api/v1/auth/login` with `mobile` + `otp` OR uses dedicated verify endpoint if flow split.
4. After 6 failed attempts within 5 minutes responses return 429 (include `retry_after`).

### Future Hardening Ideas
* Add functional/LOWER index for email if migrating to PostgreSQL for faster case-insensitive lookups.
* Centralize OTP lifecycle metrics for monitoring (Grafana / Prometheus).
* Add automated lock escalation after repeated OTP throttling.


Security:
- Both endpoints require SUPERADMIN role.

