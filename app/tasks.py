# app/tasks.py
from typing import Tuple, List, Dict
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
import traceback
import glob
import uuid
import sys
import re
import os
import logging
import threading
import time
from typing import Optional, Dict
import subprocess
import secrets
import shutil

from flask import current_app
from app.extensions import db
from app.models import Video
from sqlalchemy import text, inspect as sa_inspect
from app.models.enumerations import VideoStatus

_queue = []
_lock = threading.Lock()
logger = logging.getLogger('tasks')


# Resolve external binaries (allow override via env)
def _resolve_bin(name: str, env_var: str) -> str:
    """Return absolute path to a required binary.
    Resolution order: env var -> shutil.which -> error.
    """
    env_path = os.environ.get(env_var)
    if env_path:
        return env_path
    found = shutil.which(name)
    if found:
        return found
    raise FileNotFoundError(
        f"Required binary '{name}' not found in PATH. Set {env_var} to the full path or install '{name}' (e.g. 'sudo apt install ffmpeg')."
    )

try:
    FFMPEG_BIN = _resolve_bin("ffmpeg", "FFMPEG_BIN")
    FFPROBE_BIN = _resolve_bin("ffprobe", "FFPROBE_BIN")
except Exception as _bin_err:
    # Defer raising until actually used in worker to avoid import-time failures in contexts that don't need it.
    FFMPEG_BIN = "ffmpeg"
    FFPROBE_BIN = "ffprobe"


def extract_thumbnail_ffmpeg(video_path, video_uuid, output_dir="thumbnails", time="00:00:01"):
    os.makedirs(output_dir, exist_ok=True)
    thumbnail_path = os.path.join(output_dir, f"{video_uuid}.jpg")

    command = [
        FFMPEG_BIN,
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

            # Validate required binaries before processing
            for name, bin_path, env_var in (
                ("ffmpeg", FFMPEG_BIN, "FFMPEG_BIN"),
                ("ffprobe", FFPROBE_BIN, "FFPROBE_BIN"),
            ):
                resolved = shutil.which(bin_path) if os.sep not in bin_path else (bin_path if os.path.exists(bin_path) else None)
                if not resolved:
                    raise RuntimeError(
                        f"Missing dependency: {name} not found (looked for '{bin_path}'). Install ffmpeg (includes ffprobe) or set {env_var}."
                    )

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
            FFPROBE_BIN, "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0"
        ] + [path], capture_output=True, text=True, check=True)

        width, height = map(int, result.stdout.strip().split(','))
        return width, height
    except Exception as e:
        raise RuntimeError(f"Failed to get resolution: {e}")

def _probe_fps(input_file: str) -> float:
    try:
        out = subprocess.check_output(
            [FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate", "-of", "default=nk=1:nw=1", input_file],
            text=True
        ).strip()
        if "/" in out:
            n, d = out.split("/")
            return float(n) / float(d)
        return float(out)
    except Exception:
        return 25.0


def _probe_video_resolution(input_file: str) -> Tuple[int, int]:
    try:
        meta = json.loads(subprocess.check_output(
            [FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "json", input_file],
            text=True
        ))
        w = int(meta["streams"][0]["width"])
        h = int(meta["streams"][0]["height"])
        return w, h
    except Exception:
        return 1920, 1080


def _probe_has_audio(input_file: str) -> bool:
    try:
        out = subprocess.check_output(
            [FFPROBE_BIN, "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index", "-of", "csv=p=0", input_file],
            text=True
        ).strip()
        return bool(out)
    except Exception:
        return False


def convert_to_hls(input_file: str, video_id: str, segment_time: int = 4) -> str:
    """
    Create HLS (AES-128, MPEG-TS) at:
      app/static/hls_output/<video_id>/master.m3u8
    Variant folders/playlists keep your names:
      4k/4k.m3u8, 1440p/1440p.m3u8, 1080p/1080p.m3u8, 720p/720p.m3u8, 480p/480p.m3u8, 360p/360p.m3u8
    """
    user_variants: List[Dict] = [
        {"name": "4k",    "width": 3840, "height": 2160,
            "bitrate": 12000, "audio_bitrate": 192},
        {"name": "1440p", "width": 2560, "height": 1440,
            "bitrate":  8000, "audio_bitrate": 160},
        {"name": "1080p", "width": 1920, "height": 1080,
            "bitrate":  5000, "audio_bitrate": 128},
        {"name": "720p",  "width": 1280, "height":  720,
            "bitrate":  3000, "audio_bitrate":  96},
        {"name": "480p",  "width":  854, "height":  480,
            "bitrate":  1500, "audio_bitrate":  96},
        {"name": "360p",  "width":  640, "height":  360,
            "bitrate":   800, "audio_bitrate":  64},
    ]

    orig_w, orig_h = _probe_video_resolution(input_file)
    has_audio = _probe_has_audio(input_file)

    variants = [v for v in user_variants if v["width"]
                <= orig_w and v["height"] <= orig_h]
    if not variants:
        variants = [user_variants[-1]]

    output_dir = os.path.join("app", "static", "hls_output", video_id)
    os.makedirs(output_dir, exist_ok=True)

    # AES-128 key (one key for all variants)
    keys_dir = os.path.join(output_dir, "keys")
    os.makedirs(keys_dir, exist_ok=True)
    key_path = os.path.join(keys_dir, "enc.key")
    with open(key_path, "wb") as f:
        f.write(secrets.token_bytes(16))
    key_info_path = os.path.join(output_dir, "enc.keyinfo")
    # key URI is relative to variant playlists (../keys/enc.key from <variant>/name.m3u8)
    with open(key_info_path, "w") as f:
        f.write("../keys/enc.key\n" + os.path.abspath(key_path) + "\n")

    # Filters: split -> scale (AR keep) -> pad to exact WxH (even) -> setsar=1
    fps = _probe_fps(input_file)
    gop = max(1, int(round(segment_time * fps)))

    split_labels = [f"v{i}" for i in range(len(variants))]
    filters = [f"[0:v]split={len(variants)}" +
               "".join(f"[{lbl}]" for lbl in split_labels)]
    for i, v in enumerate(variants):
        w, h = v["width"], v["height"]
        filters.append(
            f"[{split_labels[i]}]"
            f"scale=w={w}:h={h}:force_original_aspect_ratio=decrease:flags=bicubic,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1[v{i}s]"
        )
    filter_complex = ";".join(filters)

    cmd = [FFMPEG_BIN, "-y", "-i", input_file,
           "-filter_complex", filter_complex]

    var_map_parts: List[str] = []
    for i, v in enumerate(variants):
        vb = v["bitrate"]
        ab = v["audio_bitrate"]
        maxrate = int(vb * 1.4)
        bufsize = int(vb * 1.5)

        cmd += [
            "-map", f"[v{i}s]",
            f"-c:v:{i}", "libx264",
            f"-profile:v:{i}", "high",
            f"-level:v:{i}", "4.1",
            f"-preset:v:{i}", "veryfast",
            f"-x264-params:v:{i}", f"scenecut=0:open_gop=0:min-keyint={gop}:keyint={gop}",
            f"-g:v:{i}", str(gop),
            f"-keyint_min:v:{i}", str(gop),
            f"-b:v:{i}", f"{vb}k",
            f"-maxrate:v:{i}", f"{maxrate}k",
            f"-bufsize:v:{i}", f"{bufsize}k",
            f"-pix_fmt:v:{i}", "yuv420p",
        ]

        if has_audio:
            cmd += [
                "-map", "0:a:0?",
                f"-c:a:{i}", "aac",
                f"-b:a:{i}", f"{ab}k",
                f"-ac:a:{i}", "2",
            ]
            var_map_parts.append(f"v:{i},a:{i}")
        else:
            var_map_parts.append(f"v:{i}")

    # Prepare %v working dirs
    for i in range(len(variants)):
        os.makedirs(os.path.join(output_dir, str(i),
                    "segments"), exist_ok=True)

    # HLS (TS) muxing – write segments into "<...>/%v/segments/segment_*.ts"
    cmd += [
        "-f", "hls",
        "-hls_time", str(segment_time),
        "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments+append_list",
        "-hls_segment_filename", os.path.join(output_dir,
                                              "%v", "segments", "segment_%06d.ts"),
        "-hls_key_info_file", key_info_path,
        "-master_pl_name", "master.m3u8",
        "-var_stream_map", " ".join(var_map_parts),
        os.path.join(output_dir, "%v", "index.m3u8"),
    ]

    subprocess.run(cmd, check=True)

    # Rename "%v" → friendly names and "index.m3u8" → "<name>.m3u8"
    idx_to_name = {str(i): variants[i]["name"] for i in range(len(variants))}
    for idx, friendly in idx_to_name.items():
        src = os.path.join(output_dir, idx)
        dst = os.path.join(output_dir, friendly)
        if os.path.isdir(src):
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.move(src, dst)
            old_pl = os.path.join(dst, "index.m3u8")
            new_pl = os.path.join(dst, f"{friendly}.m3u8")
            if os.path.exists(old_pl):
                os.replace(old_pl, new_pl)

    # Fix master URIs: "0/index.m3u8" → "<name>/<name>.m3u8"
    master_path = os.path.join(output_dir, "master.m3u8")
    with open(master_path, "r", encoding="utf-8") as f:
        master_txt = f.read()

    def _swap_uri(match: re.Match) -> str:
        path = match.group(1)  # e.g. "0/index.m3u8"
        first, _, _ = path.partition("/")
        friendly = idx_to_name.get(first, first)
        return f"{friendly}/{friendly}.m3u8"

    master_txt = re.sub(r"^(\d+/index\.m3u8)\s*$", _swap_uri,
                        master_txt, flags=re.MULTILINE)

    with open(master_path, "w", encoding="utf-8") as f:
        f.write(master_txt)

    # >>> NEW: ensure each VARIANT playlist points to "segments/segment_*.ts"
    for friendly in idx_to_name.values():
        pl_path = os.path.join(output_dir, friendly, f"{friendly}.m3u8")
        if not os.path.exists(pl_path):
            continue
        with open(pl_path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()

        fixed_lines = []
        for line in lines:
            if line.startswith("#"):
                fixed_lines.append(line)
                continue
            # If it's a media segment line and doesn't already include a slash, prefix with "segments/"
            # (covers names like "segment_000000.ts" → "segments/segment_000000.ts")
            if line and (line.endswith(".ts") or ".ts?" in line) and ("/" not in line.split("?")[0]):
                fixed_lines.append(f"segments/{line}")
            else:
                fixed_lines.append(line)

        with open(pl_path, "w", encoding="utf-8") as f:
            f.write("\n".join(fixed_lines) + "\n")

    return os.path.abspath(master_path)
