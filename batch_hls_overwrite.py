# === batch_hls_overwrite.py ===
import os
import re
import sys
import uuid
import glob
import shutil
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import json
import secrets
import subprocess
from typing import Tuple, List, Dict

FFMPEG_BIN = "ffmpeg"
FFPROBE_BIN = "ffprobe"


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



# If convert_to_hls is in another module, import it:
# from yourmodule.convert import convert_to_hls
# For same-file usage, ensure convert_to_hls is defined above this code.

UPLOAD_DIR = "app/uploads"
OUTPUT_BASE = os.path.join("app", "static", "hls_output")

UUID_RX = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mpg", ".mpeg", ".mkv", ".avi", ".wmv"}


def extract_uuid_from_name(filename: str) -> str | None:
    """Return first UUID-like string found in the filename (no directories)."""
    m = UUID_RX.search(os.path.basename(filename))
    return m.group(0).lower() if m else None


def iter_upload_files(upload_dir: str):
    """Yield absolute paths of candidate video files in upload_dir."""
    for path in glob.glob(os.path.join(upload_dir, "*")):
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(path)[1].lower()
        if ext in VIDEO_EXTS:
            yield os.path.abspath(path)


def convert_one(path: str, segment_time: int = 4) -> tuple[str, str | None]:
    """
    Convert one file and ALWAYS overwrite its output folder if present.
    Returns (video_id, master_path or None).
    """
    vid = extract_uuid_from_name(path)
    if not vid:
        # fallback: deterministic UUID from filename (stable across runs)
        vid = str(uuid.uuid5(uuid.NAMESPACE_URL, os.path.basename(path)))

    out_dir = os.path.join(OUTPUT_BASE, vid)

    # OVERWRITE: nuke any previous output for this UUID
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir, ignore_errors=True)

    os.makedirs(OUTPUT_BASE, exist_ok=True)

    try:
        print(f"[start] {os.path.basename(path)} → {vid}")
        master_path = convert_to_hls(path, vid, segment_time=segment_time)
        print(f"[done ] {os.path.basename(path)} → {vid}  ->  {master_path}")
        return vid, master_path
    except Exception as e:
        print(f"[FAIL ] {os.path.basename(path)} → {vid}: {e}")
        traceback.print_exc()
        return vid, None


def batch_convert_overwrite(
    upload_dir: str = UPLOAD_DIR,
    workers: int = 2,
    segment_time: int = 4,
):
    """
    Convert ALL videos in upload_dir; always overwrite existing outputs.
    """
    files = list(iter_upload_files(upload_dir))
    if not files:
        print(f"No video files found in: {upload_dir}")
        return

    print(f"Found {len(files)} file(s) in {upload_dir}")
    print(f"Workers: {workers} | segment_time: {segment_time}s | overwrite: YES")

    results = []
    # Keep workers modest; ffmpeg is already multi-threaded internally
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(convert_one, p, segment_time) for p in files]
        for fut in as_completed(futs):
            results.append(fut.result())

    ok = sum(1 for _, m in results if m)
    print(f"\nSummary: {ok}/{len(results)} succeeded")
    for vid, m in results:
        if m:
            print(f"  ✓ {vid} -> {m}")
        else:
            print(f"  ✗ {vid} -> FAILED")


if __name__ == "__main__":
    # CLI:
    #   python batch_hls_overwrite.py           # workers=2, seg=4s
    #   python batch_hls_overwrite.py 3 6       # workers=3, seg=6s
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    segtime = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    batch_convert_overwrite(UPLOAD_DIR, workers=workers, segment_time=segtime)
