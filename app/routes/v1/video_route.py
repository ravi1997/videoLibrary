# app/routes/api.py
# One-file bundle: Marshmallow schemas + API routes for a YouTube-like experience

import hashlib
from math import ceil
import mimetypes
import subprocess
from flask_jwt_extended import get_jwt_identity
import os
from datetime import datetime, timedelta,timezone
from typing import List
from urllib import response
import uuid
from sqlalchemy.exc import SQLAlchemyError

from flask import Blueprint, Response, current_app, jsonify, request, send_from_directory, abort
from flask_jwt_extended import jwt_required
from marshmallow import EXCLUDE
from sqlalchemy import and_, case, desc, or_, func

from app.extensions import db
from app.models.video import Favourite, VideoProgress
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
from app.utils.decorator import require_roles  # we'll define in #2
from flask_jwt_extended import get_jwt_identity

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
    """Utility: paginate a SQLAlchemy query and return JSON with meta."""
    try:
        page = int(request.args.get("page", 1))
        per_page = int(request.args.get("per_page", default_per_page))
    except ValueError:
        abort(400, description="Invalid pagination params")

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

@video_bp.route("/hls/<string:video_id>/master.m3u8", methods=["GET"])
def hls_master(video_id):
    """
    Serve the .m3u8 stored in Video.file_path.
    file_path should point to .../master.m3u8. We serve the file from its folder.
    """
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    if not video.file_path or not os.path.exists(video.file_path):
        abort(404, description="HLS master not found")


    video.views = (video.views or 0) + 1
    db.session.commit()

    directory = os.path.dirname(video.file_path)
    filename = os.path.basename(video.file_path)
    
    path = os.path.join(directory, filename)
    print(f"Serving HLS master from {directory}/{filename}")
    
    if not os.path.exists(path):
        abort(404, description="HLS master not found")

    # Read entire file (usually small) to modify headers
    with open(path, "rb") as f:
        data = f.read()
    resp = Response(data, status=200, mimetype="application/vnd.apple.mpegurl")

    # 🔑 remove range semantics
    resp.headers["Accept-Ranges"] = "none"
    resp.headers.pop("Content-Range", None)

    # no caching for playlists
    resp.headers["Cache-Control"] = "no-store"

    # allow cross-origin playback
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Range, Origin, X-Requested-With, Content-Type, Accept, Authorization"
    resp.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"

    return resp

    


@video_bp.route("/hls/<string:video_id>/<path:asset>", methods=["GET"])
def hls_assets(video_id, asset):
    """
    Optional helper to serve HLS segments/keys under the same folder as master.m3u8
    Example: /hls/<id>/segments/segment_000.ts or /hls/<id>/keys/key.key
    """
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    base_dir = os.path.dirname(video.file_path)
    full_path = os.path.join(base_dir, asset)

    if not os.path.commonpath([os.path.realpath(full_path), os.path.realpath(base_dir)]) == os.path.realpath(base_dir):
        abort(403)  # path traversal guard

    if not os.path.exists(full_path):
        abort(404)

    # Let Flask infer type
    return send_from_directory(base_dir, asset)





@video_bp.route('/progress/<string:video_id>', methods=['GET'])
@jwt_required()
def get_progress(video_id):
    user_id = get_jwt_identity()
    progress = VideoProgress.query.filter_by(
        user_id=user_id, video_id=video_id).first()
    return jsonify({
        "position": round(progress.position, 2) if progress else 0
    })


@video_bp.route('/progress', methods=['POST'])
@jwt_required()
def save_progress():
    user_id = get_jwt_identity()
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
    return jsonify({"message": "Progress saved", "position": round(position, 2)})


@video_bp.route("/history/latest", methods=["GET"])
@jwt_required()
def get_latest_history():
    user_id = get_jwt_identity()
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
    return jsonify(results)


@video_bp.route("/history", methods=["GET"])
@jwt_required()
def get_watch_history():
    user_id = get_jwt_identity()

    # ---- query params ----
    page = request.args.get("page", 1, type=int)
    page_size = request.args.get("page_size", 12, type=int)
    page_size = max(1, min(page_size, 100))  # clamp 1..100
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

    return jsonify({
        "items": items,
        "count": total,
        "page": page,
        "pages": pages,
        "total_watched_sec": int(total_watched_sec),
    }), 200


@video_bp.route("/history/<string:video_id>", methods=["DELETE"])
@jwt_required()
def delete_history_item(video_id: str):
    """
    Removes a single watch-history record for the logged-in user.
    `video_id` should match Video.uuid (since VideoProgress.video_id == Video.uuid in your join).
    """
    user_id = get_jwt_identity()

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

    return jsonify({"removed": int(deleted), "ok": True}), 200


# DELETE /api/v1/me/history  -> clear entire history for this user
@video_bp.route("/history", methods=["DELETE"])
@jwt_required()
def clear_history():
    """
    Clears the entire watch history of the logged-in user.
    """
    user_id = get_jwt_identity()

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

    return jsonify({"removed": int(deleted), "ok": True}), 200

# ------------------------------------------------------------------------------
# 2) Video Metadata (detail)
# ------------------------------------------------------------------------------

@video_bp.route("/<string:video_id>", methods=["GET"])
def get_video(video_id):
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    return video_schema.dump(video), 200


# ------------------------------------------------------------------------------
# 3) Recommendations & 4) Watch Next
# ------------------------------------------------------------------------------

@video_bp.route("/<string:video_id>/recommendations", methods=["GET"])
def recommendations(video_id):
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    recs = _recommend_by_tags(video, limit=12)
    # fall back to same-category if no tags
    if not recs:
        recs = _related_by_category(video, limit=12)
    return videos_mini_schema.dump(recs), 200


@video_bp.route("/<string:video_id>/watch-next", methods=["GET"])
def watch_next(video_id):
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    related = _related_by_category(
        video, limit=3) or _recommend_by_tags(video, limit=3)
    return (videos_mini_schema.dump(related), 200) if related else (jsonify([]), 200)


# ------------------------------------------------------------------------------
# 5) List Videos (with filters + pagination)
# ------------------------------------------------------------------------------

@video_bp.route("/", methods=["GET"])
def list_videos():
    q = Video.query

    category = request.args.get("category")
    if category:
        category_db = Category.query.filter(
            func.lower(Category.name) == func.lower(category)
        ).first()

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

    
    return paginate_query(q, videos_mini_schema, default_per_page=12)


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

    return jsonify({
        "favorites": fav_count or 0,
        "watched": watched_count or 0,
    }), 200

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
def upload_video():
    user_uuid = get_jwt_identity()
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

        enqueue_transcode(video.uuid)
        extract_thumbnail_ffmpeg(path, video_uuid, output_dir=THUMBNAILS_DIR)
        return jsonify({"uuid": video.uuid, "status": video.status.value}), 201

    except Exception as e:
        current_app.logger.error(f"Upload failed: {str(e)}")
        return jsonify({"error": f"Error saving video: {str(e)}"}), 500


@video_bp.route("/", methods=["POST"])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
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
    user = User.query.get(user_uuid)
    if not user:
        return jsonify({"error": "User not found"}), 404

    # Fetch video from DB
    video = Video.query.get(data.uuid)
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
            print("tag : ", tag)
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

    return jsonify(VideoMetaInputSchema().dump(video)), 200


@video_bp.route("/<string:video_id>", methods=["PUT"])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def update_video(video_id):
    editor_id = get_jwt_identity()
    video = Video.query.filter_by(uuid=video_id).first_or_404()
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
    return video_schema.dump(video), 200


@video_bp.route("/<string:video_id>", methods=["DELETE"])
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value)
def delete_video(video_id):
    deleter_id = get_jwt_identity()
    video = Video.query.filter_by(uuid=video_id).first_or_404()
    db.session.delete(video)
    db.session.commit()
    return jsonify({"ok": True}), 200


# ------------------------------------------------------------------------------
# 9) Channel (User) Info
# ------------------------------------------------------------------------------

@video_bp.route("/channels/<int:user_id>", methods=["GET"])
def channel_info(user_id):
    user = User.query.get_or_404(user_id)

    video_count = Video.query.filter_by(user_id=user.id).count()
    # subscriber_count placeholder — adapt if you have a subscriptions model
    data = user_schema.dump(user)
    data.update({
        "video_count": video_count,
        "subscriber_count": 0
    })
    return data, 200


# ------------------------------------------------------------------------------
# 10) Surgeon detail  |  11) Surgeon list
# ------------------------------------------------------------------------------

@video_bp.route("/surgeons/<int:surgeon_id>", methods=["GET"])
def surgeon_detail(surgeon_id):
    s = Surgeon.query.get_or_404(surgeon_id)
    payload = {
        **SurgeonSchema().dump(s),
        "videos": videos_mini_schema.dump(s.videos)
    }
    return payload, 200


@video_bp.route("/surgeons/paginated", methods=["GET"])
def surgeons_paginated_list():
    q = Surgeon.query.order_by(Surgeon.name.asc())
    return paginate_query(q, surgeon_schema, default_per_page=20)


# ------------------------------------------------------------------------------
# 12) Tags  |  13) Categories
# ------------------------------------------------------------------------------

@video_bp.route("/tags", methods=["GET"])
def tags_list():
    tags = Tag.query.order_by(Tag.name.asc()).all()
    return tag_schema.dump(tags), 200


@video_bp.route("/tags/top", methods=["GET"])
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
    return jsonify(payload), 200


@video_bp.route("/categories", methods=["GET"])
def categories_list():
    cats = Category.query.order_by(Category.name.asc()).all()
    return category_schema.dump(cats), 200


@video_bp.route("/trending", methods=["GET"])
def trending_videos():
    q = Video.query.order_by(Video.views.desc())
    return paginate_query(q, videos_mini_schema,default_per_page=10)


@video_bp.route("/surgeons", methods=["GET"])
def surgeons_list():
    surgeons = Surgeon.query.order_by(Surgeon.name.asc()).all()
    return surgeon_schema.dump(surgeons), 200


# ------------------------------------------------------------------------------
# Favourites
# ------------------------------------------------------------------------------

@video_bp.route("/favorite", methods=["GET"])
@jwt_required()
def favourites_list():
    user_id = get_jwt_identity()
    q = Video.query.join(Video.favourites).filter(Favourite.user_id == user_id)
    
    sort = request.args.get("sort", "recent")  # "views" or "recent"
    page = request.args.get("page", default=1, type=int)
    per_page = request.args.get("per_page", default=12, type=int)

    if sort == "recent":
        q = q.order_by(Video.created_at.desc())
    else:
        q = q.order_by(Video.title.asc())

    return paginate_query(q, videos_mini_schema)

@video_bp.route("/<string:video_id>/favorite", methods=["GET"])
@jwt_required()
def favourite_status(video_id):
    user_id = get_jwt_identity()
    favourite = Favourite.query.filter_by(
        user_id=user_id, video_id=video_id).first()
    if favourite:
        return jsonify({"favorite": True}), 200
    else:
        return jsonify({"favorite": False}), 200

@video_bp.route("/<string:video_id>/favorite", methods=["POST"])
@jwt_required()
def add_favourite(video_id):
    user_id = get_jwt_identity()
    favourite = Favourite(user_id=user_id, video_id=video_id)
    db.session.add(favourite)
    db.session.commit()
    return jsonify({"ok": True}), 200

@video_bp.route("/<string:video_id>/favorite", methods=["DELETE"])
@jwt_required()
def remove_favourite(video_id):
    user_id = get_jwt_identity()
    favourite = Favourite.query.filter_by(user_id=user_id, video_id=video_id).first()
    if favourite:
        db.session.delete(favourite)
        db.session.commit()
    return jsonify({"ok": True}), 200


# ------------------------------------------------------------------------------
# 14) Search
# ------------------------------------------------------------------------------

@video_bp.route("/search", methods=["GET"])
@jwt_required()
def search_videos():
    q = request.args.get("q", "").strip()
    category_filter = request.args.get("category")
    min_duration = request.args.get("duration_min", type=int)
    max_duration = request.args.get("duration_max", type=int)
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    
    sort = request.args.get("sort", "recent")  # "views" or "recent"
    page = request.args.get("page", default=1, type=int)
    per_page = request.args.get("per_page", default=12, type=int)

    tags = request.args.getlist("tags")

    # TODO: dynamically fetch from auth/session
    user_id = get_jwt_identity()

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

    # Keyword search
    if q:
        query = query.filter(
            or_(
                Video.title.ilike(f"%{q}%"),
                Video.description.ilike(f"%{q}%"),
                Video.transcript.ilike(f"%{q}%"),
                Tag.name.ilike(f"%{q}%"),
                Category.name.ilike(f"%{q}%"),
                Surgeon.name.ilike(f"%{q}%"),
            )
        )

    # Filters
    if category_filter:
        query = query.filter(Category.name == category_filter)

    if min_duration is not None:
        query = query.filter(Video.duration >= min_duration*60)
    if max_duration is not None:
        query = query.filter(Video.duration <= max_duration*60)

    if date_from:
        query = query.filter(Video.created_at >= datetime.fromisoformat(date_from))
    if date_to:
        query = query.filter(Video.created_at <= datetime.fromisoformat(date_to))

    if tags:
        query = query.filter(Tag.name.in_(tags))

    # Sorting
    if sort == "most_viewed":
        query = query.order_by(Video.views.desc())
    elif sort == "recent":
        query = query.order_by(Video.created_at.desc())


    query = query.distinct()

    # Paginate results
    paginated = query.paginate(page=page, per_page=per_page, error_out=False)

    # Serialize results
    items = []
    for video, position in paginated.items:
        video_dict = video_schema.dump(video)
        video_dict["position"] = round(position or 0, 2)
        items.append(video_dict)

    return jsonify({
        "items": items,
        "page": paginated.page,
        "per_page": paginated.per_page,
        "pages": paginated.pages,
        "total": paginated.total
    })



# ------------------------------------------------------------------------------
# 15) Thumbnails (Static helper)
# ------------------------------------------------------------------------------

@video_bp.route("/thumbnails/<string:video_id>.jpg", methods=["GET"])
def serve_thumbnail(video_id):
    # Change this directory to where your thumbnails live
    thumb_dir = THUMBNAILS_DIR
    path = os.path.join(thumb_dir, f"{video_id}.jpg")
    if not os.path.exists(path):
        abort(404)
    return send_from_directory(thumb_dir, f"{video_id}.jpg")


# ------------------------------------------------------------------------------
# 16) Views  |  17) Likes (placeholders; add columns in Video if needed)
# ------------------------------------------------------------------------------

@video_bp.route("/<string:video_id>/view", methods=["POST"])
def add_view(video_id):
    # If you add a 'views' column on Video, update it here.
    # Example:
    # video = Video.query.filter_by(uuid=video_id).first_or_404()
    # video.views = (video.views or 0) + 1
    # db.session.commit()
    return jsonify({"status": "ok"}), 201


@video_bp.route("/<string:video_id>/like", methods=["POST"])
def add_like(video_id):
    # If you add a 'likes' table or column, update it here.
    return jsonify({"status": "ok"}), 201


# ------------------------------------------------------------------------------
# Analytics / Gesture logs (optional)
# ------------------------------------------------------------------------------

@video_bp.route("/analytics", methods=["POST"])
def analytics():
    payload = request.get_json(force=True, silent=True) or {}
    # Store in your analytics store / DB here
    # print("Analytics payload:", payload)
    return jsonify({"ok": True}), 201
