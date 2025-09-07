import hashlib
import json
import hashlib as _hashlib
import subprocess
from flask_jwt_extended import get_jwt_identity
import os
from datetime import datetime, timedelta, timezone
from typing import List
import uuid
from sqlalchemy.exc import SQLAlchemyError

from flask import Blueprint, Response, current_app, jsonify, request, send_from_directory, abort
from flask_jwt_extended import jwt_required
from marshmallow import EXCLUDE
from sqlalchemy import and_, case, desc, or_, func, literal, literal_column
import re

from app.extensions import db
from app.models.video import Favourite, VideoProgress, VideoViewEvent
from app.schemas.video_schema import (
    VideoMetaInputSchema, VideoMiniSchema, TagSchema, CategorySchema,
    SurgeonSchema, UserSchema
)

from app.models import (
    Video, VideoTag, Tag, Category, Surgeon, VideoSurgeon, User
)
from app.models.enumerations import Role, VideoStatus

from werkzeug.utils import secure_filename
from app.tasks import enqueue_transcode, extract_thumbnail_ffmpeg
from app.utils import metrics_cache
from app.utils.decorator import require_roles  # we'll define in #2
from app.security_utils import rate_limit, ip_and_path_key, audit_log, coerce_uuid
from app.utils.uploads import ALLOWED_VIDEO_EXT, VIDEO_MIME_PREFIX, get_max_video_mb
from app.utils.api_helper import parse_pagination_params

video_schema = VideoMetaInputSchema()
videos_schema = VideoMetaInputSchema(many=True)
video_mini_schema = VideoMiniSchema()
videos_mini_schema = VideoMiniSchema(many=True)
tag_schema = TagSchema(many=True)
category_schema = CategorySchema(many=True)
surgeon_schema = SurgeonSchema(many=True)
user_schema = UserSchema()

# ------------------------------------------------------------------------------
# Blueprint
# ------------------------------------------------------------------------------

video_bp = Blueprint("video_bp", __name__)

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------


def paginate_query(query, schema, default_per_page=12):
    """Utility: paginate a SQLAlchemy query and return JSON with meta.

    Accepts either `per_page` or `page_size` (alias) as request args.
    Keeps response keys as {items, page, per_page, total, pages} for compatibility.
    """
    # Parse page via helper (clamps to >=1)
    page, page_size = parse_pagination_params(default_page=1, default_page_size=default_per_page, max_page_size=100)
    # Allow explicit per_page to override alias
    per_page_arg = request.args.get("per_page")
    if per_page_arg is not None:
        try:
            per_page = max(1, int(per_page_arg))
        except ValueError:
            abort(400, description="Invalid pagination params")
    else:
        per_page = page_size

    page_obj = query.paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({
        "items": schema.dump(page_obj.items),
        "page": page_obj.page,
        "per_page": page_obj.per_page,
        "total": page_obj.total,
        "pages": page_obj.pages
    })


def _recommend_by_tags(video: Video, limit: int = 6) -> List[Video]:
    tag_ids = [t.id for t in video.tags]
    if not tag_ids:
        return []
    q = (
        Video.query
        .join(Video.tags)
        .filter(Tag.id.in_(tag_ids), Video.uuid != video.uuid)
        .distinct()
        .limit(limit)
    )
    return q.all()


def _related_by_category(video: Video, limit: int = 6) -> List[Video]:
    if not video.category_id:
        return []
    q = (
        Video.query
        .filter(Video.category_id == video.category_id, Video.uuid != video.uuid)
        .limit(limit)
    )
    return q.all()


# ------------------------------------------------------------------------------
# 1) HLS Playback — Master Manifest + (optional) segment passthrough
# ------------------------------------------------------------------------------

def _build_master_response(video: Video):
    if not video.file_path or not os.path.exists(video.file_path):
        abort(404, description="HLS master not found")

    # Increment view count; do not commit yet if part of wider transaction
    video.views = (video.views or 0) + 1
    try:
        # If user context exists, record a view event (may be public route without JWT)
        from flask_jwt_extended import verify_jwt_in_request, get_jwt_identity
        try:
            verify_jwt_in_request(optional=True)
            uid = get_jwt_identity()
        except Exception:
            uid = None
        if uid:
            evt = VideoViewEvent(user_id=uid, video_id=video.uuid)
            db.session.add(evt)
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.warning('view_event_persist_failed', exc_info=True)

    directory = os.path.dirname(video.file_path)
    filename = os.path.basename(video.file_path)
    path = os.path.join(directory, filename)
    if not os.path.exists(path):
        abort(404, description="HLS master not found")
    with open(path, "rb") as f:
        data = f.read()
    resp = Response(data, status=200, mimetype="application/vnd.apple.mpegurl")
    resp.headers["Accept-Ranges"] = "none"
    resp.headers.pop("Content-Range", None)
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Range, Origin, X-Requested-With, Content-Type, Accept, Authorization"
    resp.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"
    return resp

@video_bp.route("/hls/<string:video_id>/master.m3u8", methods=["GET"])
@jwt_required()
def hls_master(video_id):
    """
    Serve the .m3u8 stored in Video.file_path.
    file_path should point to .../master.m3u8. We serve the file from its folder.
    """
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    try:
        audit_log('video_stream_master', target_user_id=get_jwt_identity(), detail=f'video={video_id}')
    except Exception:
        pass
    return _build_master_response(video)

    


def _serve_hls_asset(video: Video, asset: str):
    base_dir = os.path.dirname(video.file_path)
    full_path = os.path.join(base_dir, asset)
    if not os.path.commonpath([os.path.realpath(full_path), os.path.realpath(base_dir)]) == os.path.realpath(base_dir):
        abort(403)
    if not os.path.exists(full_path):
        abort(404)
    return send_from_directory(base_dir, asset)

@video_bp.route("/hls/<string:video_id>/<path:asset>", methods=["GET"])
@jwt_required()
def hls_assets(video_id, asset):
    """
    Optional helper to serve HLS segments/keys under the same folder as master.m3u8
    Example: /hls/<id>/segments/segment_000.ts or /hls/<id>/keys/key.key
    """
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    try:
        audit_log('video_stream_segment', target_user_id=get_jwt_identity(), detail=f'video={video_id};asset={asset}')
    except Exception:
        pass
    return _serve_hls_asset(video, asset)

# ---------------- Public Playback (Optional) -----------------
@video_bp.route("/public/hls/<string:video_id>/master.m3u8", methods=["GET"])
def public_hls_master(video_id):
    if not current_app.config.get("ALLOW_PUBLIC_PLAYBACK"):
        abort(404)
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    # Only allow published videos publicly
    if video.status not in [VideoStatus.PUBLISHED, VideoStatus.PROCESSED]:
        abort(403)
    try:
        audit_log('public_video_stream_master', detail=f'video={video_id}')
    except Exception:
        pass
    return _build_master_response(video)

@video_bp.route("/public/hls/<string:video_id>/<path:asset>", methods=["GET"])
def public_hls_assets(video_id, asset):
    if not current_app.config.get("ALLOW_PUBLIC_PLAYBACK"):
        abort(404)
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    if video.status not in [VideoStatus.PUBLISHED, VideoStatus.PROCESSED]:
        abort(403)
    try:
        audit_log('public_video_stream_segment', detail=f'video={video_id};asset={asset}')
    except Exception:
        pass
    return _serve_hls_asset(video, asset)





@video_bp.route('/progress/<string:video_id>', methods=['GET'])
@jwt_required()
def get_progress(video_id):
    user_id = coerce_uuid(get_jwt_identity())
    progress = VideoProgress.query.filter_by(
        user_id=user_id, video_id=video_id).first()
    resp = {"position": round(progress.position, 2) if progress else 0}
    try:
        audit_log('video_progress_get', actor_id=user_id, detail=f'video={video_id};pos={resp["position"]}')
    except Exception:
        pass
    return jsonify(resp)


@video_bp.route('/progress', methods=['POST'])
@jwt_required()
def save_progress():
    user_id = coerce_uuid(get_jwt_identity())
    data = request.get_json()
    video_id = data.get("video_id")
    position = float(data.get("position", 0))

    if not video_id:
        return jsonify({"error": "video_id is required"}), 400

    progress = VideoProgress.query.filter_by(
        user_id=user_id, video_id=video_id).first()

    if progress:
        progress.position = position
    else:
        progress = VideoProgress(
            user_id=user_id, video_id=video_id, position=position)
        db.session.add(progress)

    db.session.commit()
    try:
        audit_log('video_progress_saved', actor_id=user_id, detail=f'video={video_id};pos={position}')
    except Exception:
        pass
    return jsonify({"message": "Progress saved", "position": round(position, 2)})


@video_bp.route("/history/latest", methods=["GET"])
@jwt_required()
def get_latest_history():
    user_id = coerce_uuid(get_jwt_identity())
    history = (db.session.query(VideoProgress, Video)
               .join(Video, VideoProgress.video_id == Video.uuid)
               .filter(VideoProgress.user_id == user_id)
               .order_by(VideoProgress.updated_at.desc())
               .limit(10)
               .all())

    results = []
    for h, v in history:
        results.append({
            "uuid": v.uuid,
            "title": v.title,
            "thumbnail": f"/api/v1/video/thumbnails/{v.uuid}.jpg",
            "position": round(h.position, 2),
            "duration": v.duration,
            "views": v.views,
            "created_at": v.created_at.isoformat(),
        })
    try:
        audit_log('history_latest_view', actor_id=user_id, detail=f'count={len(results)}')
    except Exception:
        pass
    return jsonify(results)


@video_bp.route("/history", methods=["GET"])
@jwt_required()
def get_watch_history():
    user_id = coerce_uuid(get_jwt_identity())

    # ---- query params ----
    from app.utils.api_helper import parse_pagination_params
    page, page_size = parse_pagination_params(default_page=1, default_page_size=12, max_page_size=100)
    # allow explicit per_page alias to override page_size
    per_page_arg = request.args.get('per_page')
    if per_page_arg is not None:
        try:
            page_size = max(1, min(int(per_page_arg), 100))
        except Exception:
            pass
    # recent | alpha | progress
    sort = (request.args.get("sort") or "recent").lower()

    # ---- base query ----
    q = (
        db.session.query(VideoProgress, Video)
        .join(Video, VideoProgress.video_id == Video.uuid)
        .filter(VideoProgress.user_id == user_id)
    )

    # ---- sorting ----
    if sort == "alpha":
        q = q.order_by(Video.title.asc(), VideoProgress.updated_at.desc())
    elif sort == "progress":
        # Highest progress first: position / duration (NULL/0-safe)
        progress_expr = (VideoProgress.position /
                         func.nullif(Video.duration, 0.0))
        q = q.order_by(progress_expr.desc().nullslast(),
                       VideoProgress.updated_at.desc())
    else:  # "recent"
        q = q.order_by(VideoProgress.updated_at.desc())

    # ---- totals for pagination ----
    total = q.count()
    pages = max(1, ceil(total / page_size)) if total else 1
    page = min(max(1, page), pages)

    # ---- page slice ----
    rows = (
        q.offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # ---- total watched seconds across ALL history (not just this page) ----
    total_watched_sec = (
        db.session.query(
            func.coalesce(
                func.sum(
                    case(
                        (VideoProgress.position <=
                         Video.duration, VideoProgress.position),
                        else_=Video.duration
                    )
                ),
                0
            )
        )
        .join(Video, VideoProgress.video_id == Video.uuid)
        .filter(VideoProgress.user_id == user_id)
        .scalar()
    ) or 0

    # ---- build payload ----
    items = []
    for prog, vid in rows:
        items.append({
            "id": vid.uuid,  # shorthand key 'id' commonly used by UI
            "uuid": vid.uuid,
            "title": vid.title,
            "thumbnail": f"/api/v1/video/thumbnails/{vid.uuid}.jpg",
            "position": float(prog.position or 0),
            "duration": float(vid.duration or 0),
            "views": vid.views,
            "last_watched_at": prog.updated_at.isoformat() if getattr(prog, "updated_at", None) else None,
            "created_at": vid.created_at.isoformat() if getattr(vid, "created_at", None) else None,
            "url": f"/{vid.uuid}",
            # if you have relationships like vid.category.name, include safely:
            "category_name": getattr(getattr(vid, "category", None), "name", None),
            # optionally include a compact progress percentage for convenience:
            "progress_pct": int(
                100 *
                min(1.0, max(0.0, (float(prog.position or 0) / float(vid.duration or 1))))
            ),
        })

    payload = {"items": items, "count": total, "page": page, "pages": pages, "total_watched_sec": int(total_watched_sec)}
    try:
        audit_log('history_list_view', actor_id=user_id, detail=f'page={page};count={len(items)};total={total}')
    except Exception:
        pass
    return jsonify(payload), 200


@video_bp.route("/history/<string:video_id>", methods=["DELETE"])
@jwt_required()
def delete_history_item(video_id: str):
    """
    Removes a single watch-history record for the logged-in user.
    `video_id` should match Video.uuid (since VideoProgress.video_id == Video.uuid in your join).
    """
    user_id = coerce_uuid(get_jwt_identity())

    deleted = (
        db.session.query(VideoProgress)
        .filter(
            VideoProgress.user_id == user_id,
            VideoProgress.video_id == video_id,
        )
        .delete(synchronize_session=False)
    )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        # Still return idempotent "not present" state to the client
        return jsonify({"removed": 0, "ok": False}), 200

    resp = {"removed": int(deleted), "ok": True}
    try:
        audit_log('history_item_delete', actor_id=user_id, detail=f'video={video_id};removed={deleted}')
    except Exception:
        pass
    return jsonify(resp), 200


# DELETE /api/v1/me/history  -> clear entire history for this user
@video_bp.route("/history", methods=["DELETE"])
@jwt_required()
def clear_history():
    """
    Clears the entire watch history of the logged-in user.
    """
    user_id = coerce_uuid(get_jwt_identity())

    deleted = (
        db.session.query(VideoProgress)
        .filter(VideoProgress.user_id == user_id)
        .delete(synchronize_session=False)
    )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"removed": 0, "ok": False}), 200

    resp = {"removed": int(deleted), "ok": True}
    try:
        audit_log('history_cleared', actor_id=user_id, detail=f'removed={deleted}')
    except Exception:
        pass
    return jsonify(resp), 200

# ------------------------------------------------------------------------------
# 2) Video Metadata (detail)
# ------------------------------------------------------------------------------

@video_bp.route("/<string:video_id>", methods=["GET"])
@jwt_required()
def get_video(video_id):
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    try:
        audit_log('video_detail_view', actor_id=get_jwt_identity(), detail=f'video={video_id}')
    except Exception:
        pass
    return video_schema.dump(video), 200


# ------------------------------------------------------------------------------
# 3) Recommendations & 4) Watch Next
# ------------------------------------------------------------------------------

@video_bp.route("/<string:video_id>/recommendations", methods=["GET"])
@jwt_required()
def recommendations(video_id):
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    recs = _recommend_by_tags(video, limit=12)
    # fall back to same-category if no tags
    if not recs:
        recs = _related_by_category(video, limit=12)
    resp = videos_mini_schema.dump(recs)
    try:
        audit_log('video_recommendations', actor_id=get_jwt_identity(), detail=f'video={video_id};returned={len(resp)}')
    except Exception:
        pass
    return resp, 200


@video_bp.route("/<string:video_id>/watch-next", methods=["GET"])
@jwt_required()
def watch_next(video_id):
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    related = _related_by_category(
        video, limit=3) or _recommend_by_tags(video, limit=3)
    data = videos_mini_schema.dump(related) if related else []
    try:
        audit_log('video_watch_next', actor_id=get_jwt_identity(), detail=f'video={video_id};returned={len(data)}')
    except Exception:
        pass
    return (data, 200)


# ------------------------------------------------------------------------------
# 5) List Videos (with filters + pagination)
# ------------------------------------------------------------------------------

@video_bp.route("/", methods=["GET"])
@jwt_required()
def list_videos():
    q = Video.query

    category = request.args.get("category")
    if category:
        category_db = Category.query.filter(
            func.lower(Category.name) == func.lower(category)
        ).first()
        if category_db:
            q = q.filter(Video.category_id == category_db.id)


    # Filters
    status = request.args.get("status")
    if status:
        try:
            enum_val = VideoStatus(status)
            q = q.filter(Video.status == enum_val)
        except ValueError:
            abort(400, description="Invalid status")

    tags = request.args.getlist("tags")
    if tags:
        q = q.join(Video.tags).filter(Tag.name.in_(tags))

    user_id = request.args.get("user_id", type=int)
    if user_id:
        q = q.filter(Video.user_id == user_id)

    sort = request.args.get("sort", type=str)
    
    if sort:
        if sort == "trending":
            q = q.order_by(Video.views.desc())
        elif sort == "recent":
            q = q.order_by(Video.created_at.desc())
        elif sort == "most_viewed":
            q = q.order_by(Video.views.desc())
        else:
            abort(400, description="Invalid sort option")

    
    resp = paginate_query(q, videos_mini_schema, default_per_page=12)
    try:
        audit_log('video_list', actor_id=get_jwt_identity(), detail=f'category={request.args.get("category") or ""}')
    except Exception:
        pass
    return resp


@video_bp.route("/stats", methods=["GET"])
@jwt_required()
def me_stats():
    """Return profile stats for the logged-in user."""
    user_id = get_jwt_identity()

    # --- Favourites ---
    fav_count = (
        db.session.query(func.count(Favourite.video_id))
        .filter(Favourite.user_id == user_id)
        .scalar()
    )

    # --- Watched (if you track video progress/history) ---
    watched_count = (
        db.session.query(VideoProgress, Video)
        .join(Video, VideoProgress.video_id == Video.uuid)
        .filter(VideoProgress.user_id == user_id).count()
    ) or 0

    payload = {"favorites": fav_count or 0, "watched": watched_count or 0}
    try:
        audit_log('video_me_stats', actor_id=user_id, detail=f'fav={fav_count};watched={watched_count}')
    except Exception:
        pass
    return jsonify(payload), 200

# ------------------------------------------------------------------------------
# 6) Create Video (metadata only)  |  7) Update  |  8) Delete
# ------------------------------------------------------------------------------

UPLOADS_DIR = os.path.join(os.getcwd(), "app", "uploads")
THUMBNAILS_DIR = os.path.join(os.getcwd(), "app", "static", "thumbnails")
os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(THUMBNAILS_DIR, exist_ok=True)


def _parse_uuid(s: str):
    try:
        return uuid.UUID(str(s))
    except Exception:
        return None


def get_video_duration(path):
    try:
        result = subprocess.run([
            'ffprobe', '-v', 'error', '-show_entries',
            'format=duration', '-of',
            'default=noprint_wrappers=1:nokey=1', path
        ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

        output = result.stdout.decode().strip()
        return float(output) if output.replace('.', '', 1).isdigit() else None

    except Exception as e:
        print(f"Error reading duration: {e}")
        return None

def get_md5(file_path):
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        # Read in chunks to handle large files
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()



@video_bp.route("/upload", methods=["POST"])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
@rate_limit(ip_and_path_key, limit=10, window_sec=3600)
def upload_video():
    user_uuid = coerce_uuid(get_jwt_identity())
    video_uuid = str(uuid.uuid4())

    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    try:
        file = request.files["file"]
        filename = secure_filename(file.filename)
        if not filename:
            return jsonify({"error": "Invalid filename"}), 400
        allowed_ext = {".mp4", ".mov", ".mkv", ".avi"}
        ext = os.path.splitext(filename)[1].lower()
        if ext not in allowed_ext:
            return jsonify({"error": "Unsupported file type"}), 400
        path = os.path.join(UPLOADS_DIR, f"{video_uuid}_{filename}")
        file.seek(0, os.SEEK_END)
        size = file.tell()
        file.seek(0)
        max_size_mb = get_max_video_mb(current_app)
        if size > max_size_mb * 1024 * 1024:
            return jsonify({"error": "File too large"}), 400
        # MIME sniff (best-effort) to mitigate disguised uploads
        try:
            import magic  # type: ignore
            mime = magic.from_buffer(file.read(2048), mime=True)
            file.seek(0)
            if not mime.startswith(VIDEO_MIME_PREFIX):
                return jsonify({"error": "Invalid MIME type"}), 400
        except Exception:
            file.seek(0)
        
        # Save file directly
        file.save(path)

        duration = get_video_duration(path)
        md5 = get_md5(path)
        
        video = Video.query.filter_by(md5=md5).first()
        if video:
            current_app.logger.info(f"Video with MD5 {md5} already exists: {video.uuid}")
            os.remove(path)
            return jsonify({"uuid": video.uuid, "status": video.status.value}), 200
        
        # Create Video instance
        video = Video(
            uuid=video_uuid,
            title=os.path.splitext(filename)[0],
            description="",
            transcript=None,
            original_file_path=path,
            file_path=path,
            status=VideoStatus.PENDING,
            user_id=user_uuid,
            duration=duration,
            md5=md5
        )

        db.session.add(video)
        db.session.commit()
        try:
            metrics_cache.invalidate()
        except Exception:
            pass

        enqueue_transcode(video.uuid)
        extract_thumbnail_ffmpeg(path, video_uuid, output_dir=THUMBNAILS_DIR)
        try:
            audit_log('video_upload', actor_id=user_uuid, detail=f'video={video.uuid};size={size}')
        except Exception:
            pass
        return jsonify({"uuid": video.uuid, "status": video.status.value}), 201

    except Exception as e:
        current_app.logger.error(f"Upload failed: {str(e)}")
        return jsonify({"error": f"Error saving video: {str(e)}"}), 500


# ------------------------------------------------------------------------------
# Chunked / Resumable Upload API (experimental)
# Endpoints:
#   POST /upload/init     -> { filename, size, chunk_size? } => { upload_id, chunk_size, total_chunks }
#   POST /upload/chunk    -> multipart/form-data: upload_id, index, chunk, (optional) chunk_sha256
#   POST /upload/complete -> { upload_id, filename, total_chunks } => creates video (same as direct upload)
# Notes:
#   - Chooses same validation rules as direct upload (extension, size limit, mime sniff)
#   - Stores temporary parts under UPLOADS_DIR/chunks/<upload_id>/<index>.part
#   - Assembles final file then reuses logic similar to direct upload to persist Video
#   - Does NOT (yet) support partial cleanup scheduling; caller should finish upload promptly
# ------------------------------------------------------------------------------

CHUNK_DIR = os.path.join(UPLOADS_DIR, "chunks")
os.makedirs(CHUNK_DIR, exist_ok=True)
_last_cleanup_ts = None

def _cleanup_stale_sessions(max_age_hours: int = 24):
    """Remove chunk session directories older than max_age_hours.
    Called opportunistically (not guaranteed) to prevent accumulation.
    """
    global _last_cleanup_ts
    now = datetime.now(timezone.utc)
    # run at most once per hour
    if _last_cleanup_ts and (now - _last_cleanup_ts).total_seconds() < 3600:
        return
    _last_cleanup_ts = now
    try:
        for d in os.listdir(CHUNK_DIR):
            path = os.path.join(CHUNK_DIR, d)
            if not os.path.isdir(path):
                continue
            meta_path = os.path.join(path, 'meta.json')
            created = None
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, 'r') as f:
                        meta = json.load(f)
                    created_iso = meta.get('created_at')
                    if created_iso:
                        created = datetime.fromisoformat(created_iso.replace('Z',''))
                except Exception:
                    pass
            if not created:
                # fallback: directory mtime
                stat = os.stat(path)
                created = datetime.utcfromtimestamp(stat.st_mtime)
            if (now - created).total_seconds() > max_age_hours * 3600:
                # only remove if no active write (heuristic: no .lock file)
                lock_path = os.path.join(path, '.lock')
                if os.path.exists(lock_path):
                    continue
                try:
                    for fname in os.listdir(path):
                        try: os.remove(os.path.join(path, fname))
                        except Exception: pass
                    os.rmdir(path)
                except Exception:
                    pass
    except Exception:
        current_app.logger.debug("Chunk cleanup encountered an error", exc_info=True)

def _validate_extension(filename: str):
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_VIDEO_EXT:
        abort(400, description="Unsupported file type")
    return ext

def _assemble_chunks(upload_id: str, total_chunks: int, final_path: str):
    part_dir = os.path.join(CHUNK_DIR, upload_id)
    if not os.path.isdir(part_dir):
        abort(400, description="Invalid upload_id")
    with open(final_path, 'wb') as out:
        for i in range(total_chunks):
            part_path = os.path.join(part_dir, f"{i}.part")
            if not os.path.exists(part_path):
                abort(400, description=f"Missing chunk {i}")
            with open(part_path, 'rb') as pf:
                while True:
                    buf = pf.read(1024 * 1024)
                    if not buf:
                        break
                    out.write(buf)
    # cleanup
    try:
        for fname in os.listdir(part_dir):
            os.remove(os.path.join(part_dir, fname))
        os.rmdir(part_dir)
    except Exception:
        pass

def _process_final_video(path: str, filename: str, user_uuid: str):
    # Largely mirrors logic in upload_video() after file saved
    max_size_mb = get_max_video_mb(current_app)
    size = os.path.getsize(path)
    if size > max_size_mb * 1024 * 1024:
        os.remove(path)
        abort(400, description="File too large")
    # MIME sniff
    try:
        import magic  # type: ignore
        with open(path, 'rb') as f:
            mime = magic.from_buffer(f.read(2048), mime=True)
        if not mime.startswith(VIDEO_MIME_PREFIX):
            os.remove(path)
            abort(400, description="Invalid MIME type")
    except Exception:
        pass

    duration = get_video_duration(path)
    md5 = get_md5(path)
    existing = Video.query.filter_by(md5=md5).first()
    if existing:
        # Duplicate: discard new file, return existing UUID
        try: os.remove(path)
        except Exception: pass
        return existing

    video_uuid = str(uuid.uuid4())
    new_name = f"{video_uuid}_{filename}"
    final_path = os.path.join(UPLOADS_DIR, new_name)
    os.rename(path, final_path)

    video = Video(
        uuid=video_uuid,
        title=os.path.splitext(filename)[0],
        description="",
        transcript=None,
        original_file_path=final_path,
        file_path=final_path,
        status=VideoStatus.PENDING,
        user_id=user_uuid,
        duration=duration,
        md5=md5
    )
    db.session.add(video)
    db.session.commit()
    enqueue_transcode(video.uuid)
    try:
        extract_thumbnail_ffmpeg(final_path, video_uuid, output_dir=THUMBNAILS_DIR)
    except Exception:
        current_app.logger.warning("Thumbnail extraction failed for chunked upload", exc_info=True)
    return video

def _sha256_file(path: str) -> str:
    h = _hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()

@video_bp.route('/upload/init', methods=['POST'])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def init_chunk_upload():
    _cleanup_stale_sessions()
    data = request.get_json(silent=True) or {}
    filename = secure_filename(data.get('filename') or '')
    if not filename:
        return jsonify({"error": "Missing filename"}), 400
    size = int(data.get('size') or 0)
    if size <= 0:
        return jsonify({"error": "Invalid size"}), 400
    _validate_extension(filename)
    # Enforce global max size
    try:
        max_mb = get_max_video_mb(current_app)
        if size > max_mb * 1024 * 1024:
            return jsonify({"error": "File too large"}), 400
    except Exception:
        pass
    chunk_size = int(data.get('chunk_size') or (8 * 1024 * 1024))  # default 8MB
    if chunk_size < 1024 * 256:
        chunk_size = 1024 * 256
    total_chunks = (size + chunk_size - 1) // chunk_size
    upload_id = str(uuid.uuid4())
    part_dir = os.path.join(CHUNK_DIR, upload_id)
    os.makedirs(part_dir, exist_ok=True)
    # persist simple session metadata for resume/status (with user ownership)
    user_uuid = get_jwt_identity()
    meta = {
        "filename": filename,
        "size": size,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "user_id": user_uuid,
        # RFC3339 UTC timestamp
        "created_at": datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        "hash_algorithm": "sha256",
        "file_sha256": (data.get('file_sha256') or '').lower() if data.get('file_sha256') else None
    }
    try:
        with open(os.path.join(part_dir, 'meta.json'), 'w') as f:
            json.dump(meta, f)
    except Exception as e:
        current_app.logger.warning(f"Failed writing chunk meta for {upload_id}: {e}")
    resp = {"upload_id": upload_id, "chunk_size": chunk_size, "total_chunks": total_chunks}
    try:
        audit_log('chunk_upload_init', actor_id=get_jwt_identity(), detail=f'upload_id={upload_id};chunks={total_chunks}')
    except Exception:
        pass
    return jsonify(resp), 201

@video_bp.route('/upload/chunk', methods=['POST'])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def upload_chunk():
    upload_id = request.form.get('upload_id') or ''
    index = request.form.get('index') or ''
    if not upload_id or not index.isdigit():
        return jsonify({"error": "Missing upload_id or index"}), 400
    file = request.files.get('chunk')
    if not file:
        return jsonify({"error": "Missing chunk"}), 400
    part_dir = os.path.join(CHUNK_DIR, upload_id)
    if not os.path.isdir(part_dir):
        return jsonify({"error": "Invalid upload_id"}), 400
    # ownership check (if meta exists)
    meta_path = os.path.join(part_dir, 'meta.json')
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, 'r') as f:
                meta = json.load(f)
            if meta.get('user_id') != get_jwt_identity():
                return jsonify({"error": "Forbidden"}), 403
            # Enforce index bounds if total_chunks known
            try:
                total_chunks = int(meta.get('total_chunks') or -1)
                if total_chunks >= 0 and int(index) >= total_chunks:
                    return jsonify({"error": "Index out of range"}), 400
            except Exception:
                pass
        except Exception:
            pass
    idx = int(index)
    part_path = os.path.join(part_dir, f"{idx}.part")
    file.save(part_path)
    # size check vs negotiated chunk size (if available)
    try:
        max_part = int(meta.get('chunk_size') or 0)
        if max_part and os.path.getsize(part_path) > max_part:
            try: os.remove(part_path)
            except Exception: pass
            return jsonify({"error": "Chunk too large"}), 400
    except Exception:
        pass
    # integrity check if client supplied hash
    supplied_hash = request.form.get('chunk_sha256')
    if supplied_hash:
        try:
            h = _hashlib.sha256()
            with open(part_path, 'rb') as pf:
                for chunk in iter(lambda: pf.read(1024 * 1024), b''):
                    h.update(chunk)
            calc = h.hexdigest()
            if calc.lower() != supplied_hash.lower():
                try: os.remove(part_path)
                except Exception: pass
                return jsonify({"error": "Checksum mismatch", "expected": calc, "received": supplied_hash}), 400
        except Exception as e:
            current_app.logger.warning(f"Chunk hash verification failed ({upload_id}:{idx}): {e}")
            return jsonify({"error": "Hash verification error"}), 500
    # cumulative size should not exceed declared file size (if present)
    try:
        declared = int(meta.get('size') or 0)
        if declared > 0:
            total = 0
            for fname in os.listdir(part_dir):
                if fname.endswith('.part'):
                    try:
                        total += os.path.getsize(os.path.join(part_dir, fname))
                    except Exception:
                        pass
            if total > declared:
                try: os.remove(part_path)
                except Exception: pass
                return jsonify({"error": "Exceeds declared size"}), 400
    except Exception:
        pass
    resp = {"received": idx, "verified": bool(supplied_hash)}
    try:
        audit_log('chunk_upload_part', actor_id=get_jwt_identity(), detail=f'upload_id={upload_id};index={idx}')
    except Exception:
        pass
    return jsonify(resp), 200

@video_bp.route('/upload/complete', methods=['POST'])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def complete_chunk_upload():
    user_uuid = get_jwt_identity()
    data = request.get_json(silent=True) or {}
    upload_id = data.get('upload_id') or ''
    filename = secure_filename(data.get('filename') or '')
    total_chunks = int(data.get('total_chunks') or 0)
    if not upload_id or not filename or total_chunks <= 0:
        return jsonify({"error": "Missing parameters"}), 400
    _validate_extension(filename)
    part_dir = os.path.join(CHUNK_DIR, upload_id)
    if not os.path.isdir(part_dir):
        return jsonify({"error": "Invalid upload_id"}), 400
    # verify user ownership if meta exists
    meta_path = os.path.join(part_dir, 'meta.json')
    if os.path.exists(meta_path):
        try:
            with open(meta_path, 'r') as f:
                meta = json.load(f)
            if meta.get('user_id') != user_uuid:
                return jsonify({"error": "Forbidden"}), 403
            # trust original filename & total_chunks from meta, override if mismatch
            if meta.get('total_chunks') == total_chunks:
                filename = meta.get('filename') or filename
        except Exception:
            pass
    temp_path = os.path.join(part_dir, f"assembled_{uuid.uuid4()}_{filename}")
    try:
        _assemble_chunks(upload_id, total_chunks, temp_path)
        expected_sha = None
        meta_path = os.path.join(part_dir, 'meta.json')
        if os.path.exists(meta_path):
            try:
                with open(meta_path, 'r') as f:
                    meta = json.load(f)
                expected_sha = (meta.get('file_sha256') or '').lower() or None
            except Exception:
                pass
        if expected_sha:
            actual_sha = _sha256_file(temp_path)
            if actual_sha.lower() != expected_sha:
                try: os.remove(temp_path)
                except Exception: pass
                abort(400, description="Final file hash mismatch")
        video = _process_final_video(temp_path, filename, user_uuid)
        try:
            audit_log('chunk_upload_complete', actor_id=user_uuid, detail=f'upload_id={upload_id};video={video.uuid}')
        except Exception:
            pass
        return jsonify({"uuid": video.uuid, "status": video.status.value}), 201
    except Exception as e:
        current_app.logger.error(f"Chunked upload completion failed: {e}")
        return jsonify({"error": str(e)}), 500

@video_bp.route('/upload/status', methods=['GET'])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def upload_status():
    """Return server-side knowledge of already received chunks for resume logic.
    Query params: upload_id
    Response: { upload_id, received: [indexes], next_index, total_chunks, chunk_size, filename, size }
    404 if session not found. 403 if owned by another user.
    """
    upload_id = request.args.get('upload_id') or ''
    if not upload_id:
        return jsonify({"error": "upload_id required"}), 400
    part_dir = os.path.join(CHUNK_DIR, upload_id)
    if not os.path.isdir(part_dir):
        return jsonify({"error": "Not found"}), 404
    user_uuid = get_jwt_identity()
    meta = {}
    meta_path = os.path.join(part_dir, 'meta.json')
    if os.path.exists(meta_path):
        try:
            with open(meta_path, 'r') as f:
                meta = json.load(f)
        except Exception:
            meta = {}
    if meta.get('user_id') and meta.get('user_id') != user_uuid:
        return jsonify({"error": "Forbidden"}), 403
    received = []
    for fname in os.listdir(part_dir):
        if fname.endswith('.part'):
            try:
                received.append(int(fname.split('.')[0]))
            except Exception:
                pass
    received.sort()
    total_chunks = meta.get('total_chunks') or None
    chunk_size = meta.get('chunk_size') or None
    size = meta.get('size') or None
    filename = meta.get('filename') or None
    next_index = (max(received) + 1) if received else 0
    if total_chunks is not None and next_index >= total_chunks:
        next_index = total_chunks  # ready to finalize
    payload = {"upload_id": upload_id, "received": received, "next_index": next_index, "total_chunks": total_chunks, "chunk_size": chunk_size, "filename": filename, "size": size}
    try:
        audit_log('chunk_upload_status', actor_id=get_jwt_identity(), detail=f'upload_id={upload_id};received={len(received)}')
    except Exception:
        pass
    return jsonify(payload), 200


@video_bp.route("/", methods=["POST"])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
@rate_limit(ip_and_path_key, limit=30, window_sec=3600)
def create_video():
    user_uuid = get_jwt_identity()
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400

    input_schema = VideoMetaInputSchema(
        session=db.session, exclude=("user_id", "file_path", "category", "tags", "surgeons", "original_file_path", "md5"), unknown=EXCLUDE)
    try:
        data = input_schema.load(request.get_json())
    except Exception as e:
        return jsonify({"error": "Invalid input", "details": str(e)}), 400

    # Get user from JWT
    user = db.session.get(User, coerce_uuid(user_uuid))
    if not user:
        return jsonify({"error": "User not found"}), 404

    # Fetch video from DB
    video = db.session.get(Video, data.uuid)
    if not video:
        return jsonify({"error": "Video not found"}), 404

    # Update basic fields
    video.title = data.title
    video.description = data.description
    video.transcript = data.transcript
    # video.file_path = data.file_path
    video.user = user  # reassign ownership if needed

    # Category: create or assign
    category_name = request.json.get("category").get("name", "").strip()
    if category_name:
        name = category_name.strip().title()
        category = Category.query.filter_by(name=name).first()
        if not category:
            category = Category(name=name)
            db.session.add(category)
            db.session.commit()
        video.category = category

    # Tags: create or assign
    tag_names = request.json.get("tags", [])
    if tag_names:
        tags = []
        for tag in tag_names:
            name = tag.get("name", "").strip().title()
            tag = Tag.query.filter_by(name=name).first()
            if not tag:
                tag = Tag(name=name)
                db.session.add(tag)
                db.session.flush()
            tags.append(tag)
        db.session.commit()
        video.tags = tags

    # Surgeons: create or assign
    surgeon_data = request.json.get("surgeons", [])
    if surgeon_data:
        surgeons = []
        for entry in surgeon_data:
            name = entry.get("name", "").strip()
            type_ = entry.get("type", "").strip()
            if not name or not type_:
                continue
            surgeon = Surgeon.query.filter_by(name=name, type=type_).first()
            if not surgeon:
                surgeon = Surgeon(name=name, type=type_)
                db.session.add(surgeon)
                db.session.flush()
            surgeons.append(surgeon)
        db.session.commit()
        video.surgeons = surgeons

    db.session.commit()
    try:
        metrics_cache.invalidate()
    except Exception:
        pass

    try:
        audit_log('video_metadata_update', actor_id=user_uuid, detail=f'video={video.uuid}')
    except Exception:
        pass
    return jsonify(VideoMetaInputSchema().dump(video)), 200


@video_bp.route("/<string:video_id>", methods=["PUT"])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def update_video(video_id):
    editor_id = coerce_uuid(get_jwt_identity())
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    # Ownership check: allow admin or owner
    # roles are in JWT claims; fetch from request context
    from flask_jwt_extended import get_jwt
    claims = get_jwt()
    roles_claim = claims.get('roles', [])
    if video.user_id != editor_id and not any(r in roles_claim for r in [Role.ADMIN.value, Role.SUPERADMIN.value]):
        return jsonify({"error": "Not owner"}), 403
    data = request.get_json(force=True)

    for field in ["title", "description", "transcript", "file_path"]:
        if field in data:
            setattr(video, field, data[field])

    if "status" in data:
        try:
            video.status = VideoStatus[data["status"]]
        except KeyError:
            abort(400, description="Invalid status")

    if "category_id" in data:
        video.category_id = data["category_id"]

    if "tag_ids" in data:
        tags = Tag.query.filter(Tag.id.in_(data["tag_ids"] or [])).all()
        video.tags = tags

    if "surgeon_ids" in data:
        surg = Surgeon.query.filter(
            Surgeon.id.in_(data["surgeon_ids"] or [])).all()
        video.surgeons = surg

    db.session.commit()
    try:
        audit_log('video_update', actor_id=editor_id, detail=f'video={video_id}')
    except Exception:
        pass
    return video_schema.dump(video), 200


@video_bp.route("/<string:video_id>", methods=["DELETE"])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def delete_video(video_id):
    deleter_id = coerce_uuid(get_jwt_identity())
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    from flask_jwt_extended import get_jwt
    claims = get_jwt()
    roles_claim = claims.get('roles', [])
    if video.user_id != deleter_id and not any(r in roles_claim for r in [Role.ADMIN.value, Role.SUPERADMIN.value]):
        return jsonify({"error": "Not owner"}), 403
    db.session.delete(video)
    db.session.commit()
    try:
        metrics_cache.invalidate()
    except Exception:
        pass
    try:
        audit_log('video_delete', actor_id=deleter_id, detail=f'video={video_id}')
    except Exception:
        pass
    return jsonify({"ok": True}), 200


# ------------------------------------------------------------------------------
# 9) Channel (User) Info
# ------------------------------------------------------------------------------

@video_bp.route("/channels/<int:user_id>", methods=["GET"])
@jwt_required()
def channel_info(user_id):
    user = User.query.get_or_404(user_id)

    video_count = Video.query.filter_by(user_id=user.id).count()
    # subscriber_count placeholder — adapt if you have a subscriptions model
    data = user_schema.dump(user)
    data.update({
        "video_count": video_count,
        "subscriber_count": 0
    })
    try:
        audit_log('channel_info_view', actor_id=get_jwt_identity(), detail=f'user={user_id}')
    except Exception:
        pass
    return data, 200


# ------------------------------------------------------------------------------
# 10) Surgeon detail  |  11) Surgeon list
# ------------------------------------------------------------------------------

@video_bp.route("/surgeons/<int:surgeon_id>", methods=["GET"])
@jwt_required()
def surgeon_detail(surgeon_id):
    s = Surgeon.query.get_or_404(surgeon_id)
    payload = {
        **SurgeonSchema().dump(s),
        "videos": videos_mini_schema.dump(s.videos)
    }
    try:
        audit_log('surgeon_detail_view', actor_id=get_jwt_identity(), detail=f'surgeon={surgeon_id}')
    except Exception:
        pass
    return payload, 200


@video_bp.route("/surgeons/paginated", methods=["GET"])
@jwt_required()
def surgeons_paginated_list():
    q = Surgeon.query.order_by(Surgeon.name.asc())
    resp = paginate_query(q, surgeon_schema, default_per_page=20)
    try:
        audit_log('surgeons_list_view', actor_id=get_jwt_identity())
    except Exception:
        pass
    return resp


# ------------------------------------------------------------------------------
# 12) Tags  |  13) Categories
# ------------------------------------------------------------------------------

@video_bp.route("/tags", methods=["GET"])
@jwt_required()
def tags_list():
    tags = Tag.query.order_by(Tag.name.asc()).all()
    resp = tag_schema.dump(tags)
    try:
        audit_log('tags_list_view', actor_id=get_jwt_identity(), detail=f'count={len(resp)}')
    except Exception:
        pass
    return resp, 200


@video_bp.route("/tags/top", methods=["GET"])
@jwt_required()
def tags_top_list():
    limit = request.args.get("limit", 5, type=int)

    rows = (
        db.session.query(Tag.id, Tag.name, func.count(Video.uuid).label("count"))
        # or outerjoin via video_tags as above
        .join(Tag.videos)
        .group_by(Tag.id, Tag.name)
        .order_by(desc("count"), Tag.name.asc())
        .limit(limit)
        .all()
    )

    payload = [{"id": tid, "name": name, "count": int(
        cnt)} for tid, name, cnt in rows]
    try:
        audit_log('tags_top_list_view', actor_id=get_jwt_identity(), detail=f'returned={len(payload)}')
    except Exception:
        pass
    return jsonify(payload), 200


@video_bp.route("/categories", methods=["GET"])
@jwt_required()
def categories_list():
    cats = Category.query.order_by(Category.name.asc()).all()
    resp = category_schema.dump(cats)
    try:
        audit_log('categories_list_view', actor_id=get_jwt_identity(), detail=f'count={len(resp)}')
    except Exception:
        pass
    return resp, 200


@video_bp.route("/trending", methods=["GET"])
@jwt_required()
def trending_videos():
    q = Video.query.order_by(Video.views.desc())
    resp = paginate_query(q, videos_mini_schema,default_per_page=10)
    try:
        audit_log('trending_videos_view', actor_id=get_jwt_identity())
    except Exception:
        pass
    return resp


@video_bp.route("/surgeons", methods=["GET"])
@jwt_required()
def surgeons_list():
    surgeons = Surgeon.query.order_by(Surgeon.name.asc()).all()
    resp = surgeon_schema.dump(surgeons)
    try:
        audit_log('surgeons_list_all_view', actor_id=get_jwt_identity(), detail=f'count={len(resp)}')
    except Exception:
        pass
    return resp, 200


# ------------------------------------------------------------------------------
# Favourites
# ------------------------------------------------------------------------------

@video_bp.route("/favorite", methods=["GET"])
@jwt_required()
def favourites_list():
    user_id = get_jwt_identity()
    uid = coerce_uuid(user_id)
    q = Video.query.join(Video.favourites).filter(Favourite.user_id == uid)
    
    sort = request.args.get("sort", "recent")  # "most_viewed"|"recent"

    if sort == "recent":
        q = q.order_by(Video.created_at.desc())
    else:
        q = q.order_by(Video.title.asc())

    resp = paginate_query(q, videos_mini_schema)
    try:
        audit_log('favorites_list_view', actor_id=get_jwt_identity())
    except Exception:
        pass
    return resp

@video_bp.route("/<string:video_id>/favorite", methods=["GET"])
@jwt_required()
def favourite_status(video_id):
    import uuid as _uuid
    user_id = get_jwt_identity()
    uid = coerce_uuid(user_id)
    favourite = Favourite.query.filter_by(
        user_id=uid, video_id=video_id).first()
    payload = {"favorite": bool(favourite)}
    try:
        audit_log('favorite_status_view', actor_id=user_id, detail=f'video={video_id};fav={payload["favorite"]}')
    except Exception:
        pass
    return jsonify(payload), 200

@video_bp.route("/<string:video_id>/favorite", methods=["POST"])
@jwt_required()
def add_favourite(video_id):
    user_id = get_jwt_identity()
    uid = coerce_uuid(user_id)
    existing = Favourite.query.filter_by(user_id=uid, video_id=video_id).first()
    if existing:
        return jsonify({"ok": True, "already": True}), 200
    fav = Favourite(user_id=uid, video_id=video_id)
    try:
        db.session.add(fav)
        db.session.commit()
        try:
            metrics_cache.invalidate()
        except Exception:
            pass
    except Exception as e:
        db.session.rollback()
        current_app.logger.warning(f"Duplicate favourite suppressed for user {user_id} video {video_id}: {e}")
    try:
        audit_log('favorite_add', actor_id=user_id, detail=f'video={video_id}')
    except Exception:
        pass
    return jsonify({"ok": True}), 200

@video_bp.route("/<string:video_id>/favorite", methods=["DELETE"])
@jwt_required()
def remove_favourite(video_id):
    user_id = get_jwt_identity()
    uid = coerce_uuid(user_id)
    favourite = Favourite.query.filter_by(user_id=uid, video_id=video_id).first()
    if favourite:
        db.session.delete(favourite)
        db.session.commit()
        try:
            metrics_cache.invalidate()
        except Exception:
            pass
    try:
        audit_log('favorite_remove', actor_id=user_id, detail=f'video={video_id}')
    except Exception:
        pass
    return jsonify({"ok": True}), 200


# ------------------------------------------------------------------------------
# 14) Search
# ------------------------------------------------------------------------------

@video_bp.route("/search", methods=["GET"])
@jwt_required()
def search_videos():
    """
    Full-text like search across Video fields without external services.

    Strategy:
      - If using PostgreSQL, leverage to_tsvector + websearch_to_tsquery with ranking.
      - Otherwise compute a heuristic score using ILIKE on multiple fields.
      - Expand the query by lightweight synonyms to improve recall.
    """
    q = request.args.get("q", "").strip()
    category_filter = request.args.get("category")
    min_duration = request.args.get("duration_min", type=int)
    max_duration = request.args.get("duration_max", type=int)
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    
    sort = request.args.get("sort", "recent")  # "views" or "recent"
    from app.utils.api_helper import parse_pagination_params
    page, page_size = parse_pagination_params(default_page=1, default_page_size=12, max_page_size=100)
    per_page_arg = request.args.get("per_page")
    if per_page_arg is not None:
        try:
            per_page = max(1, int(per_page_arg))
        except Exception:
            return jsonify({"error": "Invalid pagination params"}), 400
    else:
        per_page = page_size

    tags = request.args.getlist("tags")

    # TODO: dynamically fetch from auth/session
    user_id = get_jwt_identity()

    # --- Helper: lightweight synonyms expansion ---
    def expand_terms(text: str) -> list[str]:
        base = set()
        for tok in re.split(r"[^\w]+", text or ""):
            t = (tok or "").strip().lower()
            if len(t) >= 2:
                base.add(t)
        if not base:
            return []
        SYN = {
            'eye': ['ocular','ophthalmic','optic'],
            'surgery': ['operation','procedure','surgical'],
            'video': ['clip','recording','footage'],
            'retina': ['retinal','vitreoretinal'],
            'cataract': ['lens','phaco','phacoemulsification'],
            'glaucoma': ['iop','intraocular','pressure'],
            'cornea': ['kerato','keratoplasty'],
            'children': ['pediatric','paediatric','kids','child'],
            'tumor': ['neoplasm','mass','lesion'],
            'testing': ['test','evaluation','assessment','exam'],
            'laser': ['photocoagulation','yag'],
            'training': ['teaching','tutorial','learning','education'],
            'doctor': ['physician','surgeon','clinician'],
            'patient': ['case','subject'],
        }
        out = set(base)
        for b in list(base):
            for k, vals in SYN.items():
                if b == k or b in vals:
                    out.add(k)
                    for v in vals:
                        out.add(v)
        # naive morphology: plural/singular, -ing/-ed forms
        for b in list(out):
            if b.endswith('ing') and len(b) > 4:
                out.add(b[:-3])
            if b.endswith('ed') and len(b) > 3:
                out.add(b[:-2])
            if b.endswith('s') and len(b) > 2:
                out.add(b[:-1])
        return list(out)

    # Extract exact phrases in quotes for boosting
    def extract_phrases(text: str) -> list[str]:
        return [m.group(1).strip() for m in re.finditer(r'"([^"]+)"', text or '') if m.group(1).strip()]

    # --- SQL search (with Postgres FTS when available) ---
    # Start base query
    query = (
        db.session.query(Video, VideoProgress.position)
        .outerjoin(Video.tags)
        .outerjoin(Video.category)
        .outerjoin(Video.surgeons)
        .outerjoin(VideoProgress, and_(
            Video.uuid == VideoProgress.video_id,
            VideoProgress.user_id == user_id
        ))
    )

    # Keyword search (FTS on Postgres; otherwise weighted ILIKE with synonyms)
    terms = expand_terms(q)
    phrases = extract_phrases(q)
    driver = str(db.engine.url.drivername)
    use_pg = 'postgresql' in driver
    sim_available = False
    if q:
        if use_pg:
            # Use stored weighted search_vec (already includes related fields via triggers)
            base_vec = literal_column('videos.search_vec')

            # Natural query parsing + unaccent; OR synonyms and phrases
            q_parts = [q] + [t for t in terms if t and t.lower() != (q or '').lower()] + [f'"{p}"' for p in phrases]
            tsquery = func.websearch_to_tsquery('simple', func.unaccent(' OR '.join(q_parts)))
            rank = func.ts_rank_cd(base_vec, tsquery)
            query = query.filter(base_vec.op('@@')(tsquery))
            # Attach rank for ordering later
            boost = literal(0.0)
            # small boosts for title/description contains and startswith
            boost = boost + case((Video.title.ilike(f"%{q}%"), 0.3), else_=0)
            boost = boost + case((Video.title.ilike(f"{q}%"), 0.2), else_=0)
            boost = boost + case((Video.description.ilike(f"%{q}%"), 0.1), else_=0)
            # Phrase boosts
            for ph in phrases:
                boost = boost + case((Video.title.ilike(f"%{ph}%"), 0.4), else_=0)
                boost = boost + case((Video.description.ilike(f"%{ph}%"), 0.2), else_=0)
            # Tag/category boosts
            if category_filter:
                boost = boost + case((func.lower(Category.name) == func.lower(category_filter), 0.2), else_=0)
            if tags:
                boost = boost + case((func.lower(Tag.name).in_([t.lower() for t in tags]), 0.2), else_=0)
            query = query.add_columns((rank + boost).label('rank'))
        else:
            # Weighted OR matches with synonyms
            ilikes = []
            for t in terms or [q]:
                pat = f"%{t}%"
                ilikes.append(Video.title.ilike(pat))
                ilikes.append(Video.description.ilike(pat))
                ilikes.append(Video.transcript.ilike(pat))
                ilikes.append(Tag.name.ilike(pat))
                ilikes.append(Category.name.ilike(pat))
                ilikes.append(Surgeon.name.ilike(pat))
            query = query.filter(or_(*ilikes))
            # Compute heuristic score
            def score_for(token):
                p = f"%{token}%"
                return (
                    case((Video.title.ilike(p), 5), else_=0) +
                    case((Video.description.ilike(p), 3), else_=0) +
                    case((Video.transcript.ilike(p), 2), else_=0) +
                    case((Category.name.ilike(p), 2), else_=0) +
                    case((Tag.name.ilike(p), 3), else_=0) +
                    case((Surgeon.name.ilike(p), 2), else_=0)
                )
            score_expr = literal(0)
            for t in terms or [q]:
                score_expr = score_expr + score_for(t)
            # Boost exact phrases
            for ph in phrases:
                p = f"%{ph}%"
                score_expr = score_expr + case((Video.title.ilike(p), 2), else_=0) + case((Video.description.ilike(p), 1), else_=0)
            # Light view boost
            score_expr = score_expr + func.least(func.coalesce(Video.views, 0), 1000) / 1000.0
            # Tag/category boosts when filters present
            if category_filter:
                score_expr = score_expr + case((func.lower(Category.name) == func.lower(category_filter), 1), else_=0)
            if tags:
                score_expr = score_expr + case((func.lower(Tag.name).in_([t.lower() for t in tags]), 1), else_=0)
            query = query.add_columns(score_expr.label('rank'))

            # Optional fuzzy ordering for Postgres (pg_trgm) — best-effort
            try:
                if q and len(q) >= 3:
                    sim = func.greatest(
                        func.similarity(func.coalesce(Video.title, ''), q),
                        func.similarity(func.coalesce(Video.description, ''), q),
                        func.similarity(func.coalesce(Video.transcript, ''), q)
                    )
                    query = query.add_columns(sim.label('sim'))
                    sim_available = True
            except Exception:
                sim_available = False

    # Filters
    if category_filter:
        # Prefer exact (case-insensitive) match when category exists; otherwise fallback to substring match
        cat = (category_filter or '').strip()
        if cat:
            exact = db.session.query(Category.id).filter(func.lower(Category.name) == func.lower(cat)).first()
            if exact:
                query = query.filter(func.lower(Category.name) == func.lower(cat))
            else:
                # Graceful: treat provided category as a free-text hint
                query = query.filter(Category.name.ilike(f"%{cat}%"))

    if min_duration is not None:
        query = query.filter(Video.duration >= min_duration*60)
    if max_duration is not None:
        query = query.filter(Video.duration <= max_duration*60)

    if date_from:
        try:
            query = query.filter(Video.created_at >= datetime.fromisoformat(date_from))
        except Exception:
            pass
    if date_to:
        # Make date_to inclusive for the whole day by adding 1 day and using '<'
        try:
            dt_to = datetime.fromisoformat(date_to)
            query = query.filter(Video.created_at < (dt_to + timedelta(days=1)))
        except Exception:
            pass

    if tags:
        # Case-insensitive tag match
        lowered = [t.lower() for t in tags if t]
        if lowered:
            query = query.filter(func.lower(Tag.name).in_(lowered))

    # Sorting
    if sort == "most_viewed":
        query = query.order_by(Video.views.desc())
    elif sort == "recent":
        query = query.order_by(Video.created_at.desc())
    else:
        # relevance (if rank present), otherwise fallback to recent
        if use_pg and sim_available:
            query = query.order_by(desc(literal_column('sim')), desc(literal_column('rank')), Video.created_at.desc())
        else:
            # rank is added in both branches; use literal_column for safety
            query = query.order_by(desc(literal_column('rank')), Video.created_at.desc())


    query = query.distinct()

    # Paginate results
    paginated = query.paginate(page=page, per_page=per_page, error_out=False)

    # Serialize results to the format search.js expects (mini object)
    def _mini(v: Video, pos=None):
        return {
            'uuid': v.uuid,
            'title': v.title,
            'description': v.description or '',
            'duration': float(v.duration or 0.0),
            'views': int(v.views or 0),
            'category_name': (v.category.name if getattr(v, 'category', None) else ''),
            'date': (v.created_at.isoformat() if getattr(v, 'created_at', None) else None),
            'thumbnail': f"/api/v1/video/thumbnails/{v.uuid}.jpg",
            'url': f"/{v.uuid}",
            'position': round(pos or 0, 2) if pos is not None else 0,
        }

    items = []
    for row in paginated.items:
        try:
            v = row[0]
            pos = row[1] if len(row) > 1 else None
            if isinstance(v, Video):
                items.append(_mini(v, pos))
                continue
        except Exception:
            pass
        if isinstance(row, Video):
            items.append(_mini(row))

    payload = {"items": items, "page": paginated.page, "per_page": paginated.per_page, "pages": paginated.pages, "total": paginated.total}

    # Auto-relaxation: if filters produce 0 results, retry with relaxed filters (text-only)
    if payload["total"] == 0 and (q or category_filter or tags or min_duration is not None or max_duration is not None or date_from or date_to):
        try:
            # Rebuild a simplified query: text-only, no hard filters
            rq = (
                db.session.query(Video, VideoProgress.position)
                .outerjoin(Video.tags)
                .outerjoin(Video.category)
                .outerjoin(Video.surgeons)
                .outerjoin(VideoProgress, and_(Video.uuid == VideoProgress.video_id, VideoProgress.user_id == user_id))
            )
            if q:
                if use_pg:
                    # Use stored vector
                    base_vec = literal_column('videos.search_vec')
                    q_parts = [q] + [t for t in terms if t and t.lower() != (q or '').lower()] + [f'"{p}"' for p in phrases]
                    tsquery = func.websearch_to_tsquery('simple', func.unaccent(' OR '.join(q_parts)))
                    rank = func.ts_rank_cd(base_vec, tsquery)
                    rq = rq.filter(base_vec.op('@@')(tsquery)).add_columns(rank.label('rank'))
                    rq = rq.order_by(desc(literal_column('rank')), Video.created_at.desc())
                else:
                    # Heuristic scoring
                    ilikes = []
                    for t in terms or [q]:
                        pat = f"%{t}%"
                        ilikes += [Video.title.ilike(pat), Video.description.ilike(pat), Video.transcript.ilike(pat), Tag.name.ilike(pat), Category.name.ilike(pat), Surgeon.name.ilike(pat)]
                    rq = rq.filter(or_(*ilikes))
                    score_expr = literal(0)
                    for t in terms or [q]:
                        ptn = f"%{t}%"
                        score_expr = score_expr + (
                            case((Video.title.ilike(ptn), 5), else_=0) +
                            case((Video.description.ilike(ptn), 3), else_=0) +
                            case((Video.transcript.ilike(ptn), 2), else_=0) +
                            case((Category.name.ilike(ptn), 2), else_=0) +
                            case((Tag.name.ilike(ptn), 3), else_=0) +
                            case((Surgeon.name.ilike(ptn), 2), else_=0)
                        )
                    rq = rq.add_columns(score_expr.label('rank')).order_by(desc(literal_column('rank')), Video.created_at.desc())
            else:
                rq = rq.order_by(Video.created_at.desc())

            rpag = rq.paginate(page=page, per_page=per_page, error_out=False)
            ritems = []
            for row in rpag.items:
                try:
                    v = row[0]
                    pos = row[1] if len(row) > 1 else None
                    if isinstance(v, Video):
                        ritems.append(_mini(v, pos))
                        continue
                except Exception:
                    pass
                if isinstance(row, Video):
                    ritems.append(_mini(row))
            if ritems:
                payload.update({
                    "items": ritems,
                    "page": rpag.page,
                    "per_page": rpag.per_page,
                    "pages": rpag.pages,
                    "total": rpag.total,
                    "relaxed": True,
                    "relax_reason": "filters_relaxed_for_no_results"
                })
        except Exception:
            current_app.logger.debug('relaxed_search_failed', exc_info=True)
    try:
        audit_log('video_search_builtin', actor_id=get_jwt_identity(), detail=f'q={q};returned={len(items)};driver={driver}')
    except Exception:
        pass
    return jsonify(payload)



# ------------------------------------------------------------------------------
# 15) Thumbnails (Static helper)
# ------------------------------------------------------------------------------

@video_bp.route("/thumbnails/<string:video_id>.jpg", methods=["GET"])
@jwt_required()
def serve_thumbnail(video_id):
    # Basic path safety: only allow UUID-like / slug ids
    import re
    if not re.fullmatch(r"[A-Za-z0-9\-]{1,64}", video_id or ""):
        abort(404)
    thumb_dir = THUMBNAILS_DIR
    path = os.path.join(thumb_dir, f"{video_id}.jpg")
    if not os.path.exists(path):
        abort(404)
    try:
        audit_log('thumbnail_serve', actor_id=get_jwt_identity(), detail=f'video={video_id}')
    except Exception:
        pass
    return send_from_directory(thumb_dir, f"{video_id}.jpg")


# ------------------------------------------------------------------------------
# 16) Views  |  17) Likes (placeholders; add columns in Video if needed)
# ------------------------------------------------------------------------------

@video_bp.route("/<string:video_id>/view", methods=["POST"])
@jwt_required()
def add_view(video_id):
    user_id = get_jwt_identity()
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    video.views = (video.views or 0) + 1
    evt = VideoViewEvent(user_id=user_id, video_id=video.uuid)
    try:
        db.session.add(evt)
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.warning('add_view_persist_failed', exc_info=True)
    try:
        audit_log('video_view_event', actor_id=user_id, detail=f'video={video_id}')
    except Exception:
        pass
    return jsonify({"status": "ok"}), 201


@video_bp.route("/<string:video_id>/like", methods=["POST"])
@jwt_required()
def add_like(video_id):
    # If you add a 'likes' table or column, update it here.
    try:
        audit_log('video_like', actor_id=get_jwt_identity(), detail=f'video={video_id}')
    except Exception:
        pass
    return jsonify({"status": "ok"}), 201


# ------------------------------------------------------------------------------
# Analytics / Gesture logs (optional)
# ------------------------------------------------------------------------------

@video_bp.route("/analytics", methods=["POST"])
@jwt_required()
def analytics():
    payload = request.get_json(force=True, silent=True) or {}
    # Store in your analytics store / DB here
    # print("Analytics payload:", payload)
    try:
        audit_log('analytics_event', actor_id=get_jwt_identity())
    except Exception:
        pass
    return jsonify({"ok": True}), 201
