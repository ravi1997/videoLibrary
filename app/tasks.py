# app/tasks.py
import os
import logging
import threading
import time
from typing import Optional, Dict
import subprocess
import secrets

from flask import current_app
from app.extensions import db
from app.models import Video
from sqlalchemy import text, inspect as sa_inspect
from app.models.enumerations import VideoStatus

_queue = []
_lock = threading.Lock()
logger = logging.getLogger('tasks')


def extract_thumbnail_ffmpeg(video_path, video_uuid, output_dir="thumbnails", time="00:00:01"):
    os.makedirs(output_dir, exist_ok=True)
    thumbnail_path = os.path.join(output_dir, f"{video_uuid}.jpg")

    command = [
        "ffmpeg",
        "-ss", time,  # Time offset to grab the frame (e.g., 1s)
        "-i", video_path,
        "-frames:v", "1",  # Extract only one frame
        "-q:v", "2",       # Quality (lower is better, 1-31)
        thumbnail_path
    ]

    subprocess.run(command, check=True)
    return thumbnail_path


def add_to_queue(filepath: str, video_id: str):
    with _lock:
        _queue.append((filepath, video_id))


def start_hls_worker(app):
    """
    Call this once during app startup (e.g., in create_app()).
    """
    t = threading.Thread(target=_worker_loop, args=(app,), daemon=True)
    t.start()
    # Start nightly aggregation thread (lightweight)
    a = threading.Thread(target=_nightly_rollup_loop, args=(app,), daemon=True)
    a.start()
    return t


def _worker_loop(app):
    while True:
        filepath, video_id = None, None
        with _lock:
            if _queue:
                filepath, video_id = _queue.pop(0)

        if not filepath:
            time.sleep(0.5)
            continue

        try:
            logger.info(f"Converting: %s -> video_id=%s", filepath, video_id)
            with app.app_context():
                _mark_status(video_id, VideoStatus.PENDING)

            master_path = convert_to_hls(filepath, video_id)

            with app.app_context():
                _on_success(video_id, master_path)
                logger.info("Done: %s -> %s", video_id, master_path)

        except Exception as e:
            logger.exception("Error converting %s: %s", video_id, e)
            with app.app_context():
                _on_fail(video_id, error=str(e))

        time.sleep(0.5)


# -------------------- View Event Aggregation --------------------
ROLLUP_INTERVAL_HOURS = 24
_last_rollup: float = 0.0

def _nightly_rollup_loop(app):
    """Periodically aggregate raw video_view_events into daily counts per video/user.
    Creates table video_view_daily (video_id, day, views, user_views, updated_at) if missing.
    """
    global _last_rollup
    while True:
        now = time.time()
        # Run at most once per interval
        if now - _last_rollup >= ROLLUP_INTERVAL_HOURS * 3600:
            try:
                with app.app_context():
                    _rollup_video_views()
                    _last_rollup = now
            except Exception as e:
                app.logger.warning(f"Rollup failed: {e}", exc_info=True)
        time.sleep(3600)  # wake hourly to check

def _rollup_video_views():
    """Aggregate raw events into daily summary table.
    Summary metrics:
      - total views per video per day
      - distinct user views per video per day
    """
    engine = db.engine
    # The rollup SQL uses PostgreSQL-specific syntax (AT TIME ZONE, ON CONFLICT).
    # Skip on non-Postgres engines to avoid startup noise in dev/test (SQLite).
    if getattr(engine, "name", "").lower() != "postgresql":
        current_app.logger.info("Skipping view rollup: non-PostgreSQL engine detected (%s)", getattr(engine, "name", "unknown"))
        return
    # Skip if required base table is not yet created (fresh DB before migrations)
    try:
        insp = sa_inspect(engine)
        tables = set(insp.get_table_names())
        if 'video_view_events' not in tables:
            current_app.logger.info("Skipping view rollup: base table video_view_events is missing (fresh DB)")
            return
    except Exception:
        current_app.logger.info("Skipping view rollup: failed to inspect tables (DB not ready)")
        return
    with engine.begin() as conn:
        # Ensure summary table exists (simple DDL)
        conn.execute(text("""
        CREATE TABLE IF NOT EXISTS video_view_daily (
            video_id VARCHAR(36) NOT NULL,
            day DATE NOT NULL,
            views BIGINT NOT NULL,
            user_views INTEGER NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (video_id, day)
        )
        """))
        # Insert/update aggregates for days that have raw events but are missing or stale in summary
        # (Recompute last 3 days to handle late arrivals)
        conn.execute(text("""
        INSERT INTO video_view_daily (video_id, day, views, user_views, updated_at)
        SELECT vve.video_id,
               (vve.created_at AT TIME ZONE 'UTC')::date AS day,
               COUNT(*) AS views,
               COUNT(DISTINCT vve.user_id) AS user_views,
               NOW() AS updated_at
        FROM video_view_events vve
        WHERE vve.created_at >= (NOW() - INTERVAL '3 days')
        GROUP BY vve.video_id, day
        ON CONFLICT (video_id, day) DO UPDATE SET
            views = EXCLUDED.views,
            user_views = EXCLUDED.user_views,
            updated_at = EXCLUDED.updated_at;
        """))
        # Optional: prune very old raw events (e.g., > 90 days) if table grows large
        # Commented out by default; enable when retention policy decided.
        # conn.execute(text("DELETE FROM video_view_events WHERE created_at < (NOW() - INTERVAL '180 days')"))
    current_app.logger.info("Video view rollup complete")


def enqueue_transcode(video_uuid: str) -> None:
    """
    Call this from your request handler (there's already an app/request context).
    """
    # we are in request context here, so DB access is fine
    video = Video.query.filter_by(uuid=video_uuid).first()
    if not video:
        raise ValueError(f"Video not found: {video_uuid}")

    raw_path = video.file_path
    if not raw_path or not os.path.exists(raw_path):
        raise ValueError(
            f"Raw file path missing or not found for {video_uuid}: {raw_path}")

    video.status = VideoStatus.PENDING
    db.session.commit()

    add_to_queue(raw_path, video_uuid)


def _mark_status(video_id: str, status: VideoStatus):
    """Efficient status update without loading the entity."""
    try:
        from sqlalchemy import update
        stmt = update(Video).where(Video.uuid == video_id).values(status=status)
        db.session.execute(stmt)
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise


def _on_success(video_id: str, master_path: str):
    """Set processed status and update file path via single UPDATE."""
    try:
        from sqlalchemy import update
        stmt = update(Video).where(Video.uuid == video_id).values(file_path=master_path, status=VideoStatus.PROCESSED)
        db.session.execute(stmt)
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise


def _on_fail(video_id: str, error: Optional[str] = None):
    """Mark video failed without loading it."""
    try:
        from sqlalchemy import update
        stmt = update(Video).where(Video.uuid == video_id).values(status=VideoStatus.FAILED)
        db.session.execute(stmt)
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise


def get_video_resolution(path):
    try:
        result = subprocess.run([
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0"
        ] + [path], capture_output=True, text=True, check=True)

        width, height = map(int, result.stdout.strip().split(','))
        return width, height
    except Exception as e:
        raise RuntimeError(f"Failed to get resolution: {e}")

def convert_to_hls(input_file, video_id, segment_time=10):
    """
    Writes static/hls_output/<video_id>/master.m3u8 (AES-128 encrypted variants).
    Returns absolute master.m3u8 path.
    """
    all_variants = [
        {"name": "4k", "width": 3840, "height": 2160,
            "bitrate": 12000, "audio_bitrate": 192},
        {"name": "1440p", "width": 2560, "height": 1440,
            "bitrate": 8000, "audio_bitrate": 160},
        {"name": "1080p", "width": 1920, "height": 1080,
            "bitrate": 5000, "audio_bitrate": 128},
        {"name": "720p", "width": 1280, "height": 720,
            "bitrate": 3000, "audio_bitrate": 96},
        {"name": "480p", "width": 854, "height": 480,
            "bitrate": 1500, "audio_bitrate": 96},
        {"name": "360p", "width": 640, "height": 360,
            "bitrate": 800, "audio_bitrate": 64},
    ]

    orig_width, orig_height = get_video_resolution(input_file)

    # Add source variant at original resolution
    all_variants.insert(0, {
        "name": "source",
        "width": orig_width,
        "height": orig_height,
        "bitrate": 10000,  # safe default for source, can be tuned
        "audio_bitrate": 160
    })
    
    
    output_dir = os.path.join("app", "static", "hls_output", video_id)
    os.makedirs(output_dir, exist_ok=True)
    variant_playlists = []
    
    
    # Filter variants to only include resolutions less than or equal to original
    filtered_variants = [
        v for v in all_variants
        if v["width"] <= orig_width and v["height"] <= orig_height
    ]

    for var in filtered_variants:
        variant_dir = os.path.join(output_dir, var["name"])
        segments_dir = os.path.join(variant_dir, "segments")
        keys_dir = os.path.join(variant_dir, "keys")
        playlist_path = os.path.join(variant_dir, f"{var['name']}.m3u8")
        os.makedirs(segments_dir, exist_ok=True)
        os.makedirs(keys_dir, exist_ok=True)

        key = secrets.token_bytes(16)
        key_file = os.path.join(keys_dir, "key.key")
        key_uri = "keys/key.key"
        with open(key_file, "wb") as f:
            f.write(key)

        segment_base = os.path.join(segments_dir, "segment")
        output_pattern = segment_base + "_%03d.ts"

        ffmpeg_cmd = [
            "ffmpeg", "-y", "-i", input_file,
            "-vf", f"scale={var['width']}:{var['height']}",
            "-c:v", "libx264", "-b:v", f"{var['bitrate']}k", "-preset", "fast",
            "-c:a", "aac", "-b:a", f"{var['audio_bitrate']}k",
            "-hls_time", str(segment_time),
            "-hls_playlist_type", "vod",
            "-hls_segment_filename", output_pattern,
            "-f", "hls", os.path.join(variant_dir, "temp.m3u8")
        ]
        subprocess.run(ffmpeg_cmd, check=True)

        segments = sorted(f for f in os.listdir(
            segments_dir) if f.endswith(".ts"))
        encrypted_segments = []

        for i, seg in enumerate(segments):
            segment_path = os.path.join(segments_dir, seg)
            enc_path = os.path.join(segments_dir, f"enc_{seg}")
            iv = i.to_bytes(16, "big")

            subprocess.run([
                "openssl", "aes-128-cbc", "-e",
                "-in", segment_path,
                "-out", enc_path,
                "-nosalt", "-iv", iv.hex(), "-K", key.hex()
            ], check=True)

            encrypted_segments.append({
                "filename": f"segments/enc_{seg}",
                "key_uri": key_uri,
                "iv": iv.hex()
            })

        with open(playlist_path, "w") as m3u8:
            m3u8.write("#EXTM3U\n#EXT-X-VERSION:3\n")
            m3u8.write(f"#EXT-X-TARGETDURATION:{segment_time}\n")
            m3u8.write("#EXT-X-MEDIA-SEQUENCE:0\n")
            for seg in encrypted_segments:
                m3u8.write(
                    f'#EXT-X-KEY:METHOD=AES-128,URI="{seg["key_uri"]}",IV=0x{seg["iv"]}\n')
                m3u8.write(f"#EXTINF:{segment_time:.1f},\n{seg['filename']}\n")
            m3u8.write("#EXT-X-ENDLIST\n")

        temp_path = os.path.join(variant_dir, "temp.m3u8")
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass

        variant_playlists.append({
            "name": var["name"],
            "bandwidth": var["bitrate"] * 1000,
            "resolution": f"{var['width']}x{var['height']}",
            "uri": f"{var['name']}/{var['name']}.m3u8"
        })

    master_path = os.path.join(output_dir, "master.m3u8")
    with open(master_path, "w") as master:
        master.write("#EXTM3U\n")
        for v in variant_playlists:
            master.write(
                f'#EXT-X-STREAM-INF:BANDWIDTH={v["bandwidth"]},RESOLUTION={v["resolution"]}\n')
            master.write(f"{v['uri']}\n")

    return os.path.abspath(master_path)
