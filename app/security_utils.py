import time
import re
from functools import wraps
from flask import request, jsonify, current_app
from collections import defaultdict
import os
import uuid
try:
    import redis  # type: ignore
except Exception:  # pragma: no cover
    redis = None

try:
    import orjson
except Exception:  # pragma: no cover
    orjson = None

# In-memory rate limit store (per-process). For production, replace with Redis.
_rate_store = defaultdict(list)
_redis_client = None

def init_redis():  # lazy init
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    url = os.getenv("REDIS_URL")
    if url and redis:
        try:
            _redis_client = redis.from_url(url)
        except Exception:
            current_app.logger.warning("Redis init failed, falling back to memory store")
            _redis_client = None
    return _redis_client

PASSWORD_REGEX = re.compile(
    r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-={}[\\]|:;\"'<>,.?/]).{8,72}$"
)

def password_strong(password: str) -> bool:
    if not password:
        return False
    return bool(PASSWORD_REGEX.match(password))


def rate_limit(key_func, limit: int, window_sec: int):
    """Simple decorator to rate limit endpoint calls.
    key_func(request) -> str key.
    limit: max requests in window
    window_sec: time window in seconds
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            key = key_func()
            now = time.time()
            client = init_redis()
            if client:
                try:
                    pipe = client.pipeline()
                    redis_key = f"rl:{key}:{window_sec}"
                    pipe.lpush(redis_key, now)
                    pipe.lrange(redis_key, 0, limit)  # get top 'limit' timestamps
                    pipe.ltrim(redis_key, 0, limit-1)
                    pipe.expire(redis_key, window_sec)
                    _, samples, _, _ = pipe.execute()
                    valid = [float(ts) for ts in samples if float(ts) >= now - window_sec]
                    if len(valid) > limit:
                        retry_after = int((valid[-1] + window_sec) - now)
                        current_app.logger.warning(f"Rate limit exceeded (redis) key={key}")
                        return jsonify({"error": "rate_limited", "retry_after": max(retry_after,0)}), 429
                except Exception as e:  # Redis failure -> degrade gracefully
                    current_app.logger.warning(f"Redis rate limit backend unavailable ({e}); falling back to in-memory store")
                    # Disable redis client for subsequent calls to avoid repeated exceptions
                    global _redis_client
                    _redis_client = None
                    # proceed to memory fallback below
            else:
                bucket = _rate_store[key]
                cutoff = now - window_sec
                while bucket and bucket[0] < cutoff:
                    bucket.pop(0)
                if len(bucket) >= limit:
                    current_app.logger.warning(f"Rate limit exceeded key={key}")
                    return jsonify({"error": "rate_limited", "retry_after": int(bucket[0]+window_sec-now)}), 429
                bucket.append(now)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def ip_key():
    return f"ip:{get_client_ip()}"


def ip_and_path_key():
    return f"ip:{get_client_ip()}:path:{request.path}"


def log_structured(event: str, **fields):
    """Emit structured JSON log (uses orjson if available)."""
    payload = {"event": event, **fields}
    if orjson:
        msg = orjson.dumps(payload).decode()
    else:  # pragma: no cover
        import json
        msg = json.dumps(payload, separators=(",", ":"))
    current_app.logger.info(msg)


def audit_log(event: str, *, actor_id=None, user_id=None, target_user_id=None, detail=None):
    """Persist audit log entry (best-effort).

    Backward compatible: historically callers used actor_id; newer code may pass
    user_id for clarity. If both provided, user_id wins.
    """
    try:
        from app.extensions import db
        from app.models.AuditLog import AuditLog
        from flask import request as _req
        effective_user_id = user_id or actor_id
        entry = AuditLog(
            event=event,
            user_id=str(effective_user_id) if effective_user_id else None,
            target_user_id=str(target_user_id) if target_user_id else None,
            ip=get_client_ip(),
            detail=detail
        )
        db.session.add(entry)
        db.session.commit()
    except Exception as e:  # pragma: no cover
        current_app.logger.warning(f"Audit log persist failed: {e}")


def get_client_ip() -> str:
    """Best-effort client IP extraction with basic proxy awareness.

    Trusts only the left-most X-Forwarded-For entry if header is present.
    If not present, falls back to request.remote_addr. This is a conservative
    approach; for production behind known proxies, prefer configuring
    werkzeug.middleware.proxy_fix.ProxyFix in the app factory.
    """
    try:
        # Take the first IP in XFF if available
        xff = request.headers.get('X-Forwarded-For', '')
        if xff:
            first = xff.split(',')[0].strip()
            if first:
                return first
        return request.remote_addr or ''
    except Exception:
        return ''


def coerce_uuid(value):
    """Return uuid.UUID(value) if possible, else original value.

    Helps build cross-dialect-safe filters when UUID columns are compared
    against string identities from JWT or request params.
    """
    try:
        return uuid.UUID(str(value))
    except Exception:
        return value


def allow_action(key: str, limit: int, window_sec: int):
    """Lightweight programmatic rate limiter.

    Returns (allowed: bool, retry_after: int|None)
    Uses same storage backend as @rate_limit decorator.
    """
    now = time.time()
    client = init_redis()
    if client:
        try:
            redis_key = f"ra:{key}:{window_sec}"
            pipe = client.pipeline()
            pipe.lpush(redis_key, now)
            pipe.lrange(redis_key, 0, limit)
            pipe.ltrim(redis_key, 0, limit-1)
            pipe.expire(redis_key, window_sec)
            _, samples, _, _ = pipe.execute()
            valid = [float(ts) for ts in samples if float(ts) >= now - window_sec]
            if len(valid) > limit:
                retry_after = int((valid[-1] + window_sec) - now)
                return False, max(retry_after, 0)
            return True, None
        except Exception:
            # fall through to memory
            pass
    bucket = _rate_store[key]
    cutoff = now - window_sec
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= limit:
        return False, int(bucket[0] + window_sec - now)
    bucket.append(now)
    return True, None
