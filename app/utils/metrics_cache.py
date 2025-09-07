"""Lightweight in-process cache for admin dashboard metrics.

Provides get/set/invalidate so writers across modules can invalidate without
import cycles. This is intentionally simple; for multi-process deployments,
back this with Redis in the future.
"""
from __future__ import annotations

from typing import Any, Optional
import time

_CACHE = {
    'ts': 0.0,      # epoch seconds
    'ttl': 30.0,    # seconds; keep short to avoid stale UI
    'data': None,   # cached payload (dict)
}


def configure_ttl(seconds: float) -> None:
    _CACHE['ttl'] = max(1.0, float(seconds))


def get() -> Optional[Any]:
    now = time.time()
    data = _CACHE['data']
    if data is None:
        return None
    if (now - _CACHE['ts']) < _CACHE['ttl']:
        return data
    return None


def set(data: Any) -> None:
    _CACHE['data'] = data
    _CACHE['ts'] = time.time()


def invalidate() -> None:
    _CACHE['data'] = None
    _CACHE['ts'] = 0.0

