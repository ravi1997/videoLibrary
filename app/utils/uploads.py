import os
from typing import Set
from typing import Optional, IO

# Centralized upload validation constants & helpers

# Video content
ALLOWED_VIDEO_EXT: Set[str] = {'.mp4', '.mov', '.mkv', '.avi'}
VIDEO_MIME_PREFIX = 'video/'

# Identity document uploads
ALLOWED_ID_EXT: Set[str] = {'.png', '.jpg', '.jpeg', '.pdf'}
ALLOWED_ID_MIMES: Set[str] = {'image/png', 'image/jpeg', 'application/pdf'}


def ext_allowed(filename: str, allowed: Set[str]) -> bool:
    ext = os.path.splitext(filename)[1].lower()
    return ext in allowed


def get_max_video_mb(app) -> int:
    try:
        return int(app.config.get('MAX_CONTENT_LENGTH_MB', 1000))
    except Exception:
        return 1000


def sniff_mime_stream(fileobj: IO[bytes]) -> Optional[str]:
    """Best-effort MIME sniff from a file-like stream; rewinds to start.

    Returns string like 'video/mp4' or None on failure.
    Caller should handle resetting stream position if they advanced it further.
    """
    try:
        import magic  # type: ignore
    except Exception:
        return None
    try:
        pos = None
        try:
            pos = fileobj.tell()
        except Exception:
            pos = None
        head = fileobj.read(2048)
        mime = magic.from_buffer(head, mime=True)
        if pos is not None:
            fileobj.seek(pos)
        return mime
    except Exception:
        try:
            fileobj.seek(0)
        except Exception:
            pass
        return None


def sniff_mime_path(path: str) -> Optional[str]:
    try:
        import magic  # type: ignore
        with open(path, 'rb') as f:
            return magic.from_buffer(f.read(2048), mime=True)
    except Exception:
        return None
