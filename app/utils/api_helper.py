from __future__ import annotations

from typing import Any, Dict, Tuple
from flask import jsonify, request


def ok(payload: Dict[str, Any] | None = None, status: int = 200, **extra):
    """Standard success envelope.

    Returns a JSON response: { ok: True, ...payload, ...extra }
    """
    body: Dict[str, Any] = {"ok": True}
    if payload:
        body.update(payload)
    if extra:
        body.update(extra)
    return jsonify(body), status


def error(message: str, status: int = 400, *, code: str | None = None, **extra):
    """Standard error envelope.

    Returns a JSON response: { ok: False, error: message, code?, ...extra }
    """
    body: Dict[str, Any] = {"ok": False, "error": message}
    if code:
        body["code"] = code
    if extra:
        body.update(extra)
    return jsonify(body), status


def parse_pagination_params(
    *, default_page: int = 1, default_page_size: int = 20, max_page_size: int = 100
) -> Tuple[int, int]:
    """Extract and clamp common pagination params from request.args."""
    def _to_int(val: Any, default: int) -> int:
        try:
            return int(val)
        except Exception:
            return default

    page = max(1, _to_int(request.args.get("page", default_page), default_page))
    page_size = _to_int(request.args.get("page_size", default_page_size), default_page_size)
    page_size = min(max_page_size, max(1, page_size))
    return page, page_size


def build_page_dict(items, page: int, page_size: int, total: int):
    pages = max(1, (total + page_size - 1) // page_size)
    return {"items": items, "page": page, "pages": pages, "total": total}

