import requests
from typing import Any, Dict, Optional
from flask import current_app as app


def cdac_service(emp_id: str) -> Optional[Dict[str, Any]]:
    """
    Query the CDAC single lookup endpoint for an employee.

    Args:
        emp_id: Employee ID (e.g. 'E1902460')

    Returns:
        Parsed JSON dict on success, or None on failure.
        Caller should treat None as "not found / error" and not leak details to client.
    """
    if not emp_id:
        app.logger.warning("cdac_service called without emp_id")
        return None

    url = app.config.get(
        "CDAC_SERVER",
        "http://waiting_url.com"
    )
    # Prefer a dedicated key; fall back to legacy config name if present
    token = app.config.get(
        "CDAC_API_KEY") or app.config.get("CDAC_AUTH_BEARER")
    if not token:
        app.logger.error(
            "CDAC API token not configured (CDAC_API_KEY / CDAC_AUTH_BEARER missing)")
        return None

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    payload = {"request_id": emp_id}

    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=10)
    except requests.RequestException as exc:
        app.logger.error(
            f"CDAC request exception for emp_id={emp_id}: {exc}", exc_info=True)
        return None

    if resp.status_code != 200:
        text_snippet = (resp.text or "")[:300]
        app.logger.warning(
            f"CDAC lookup failed emp_id={emp_id} status={resp.status_code} body={text_snippet!r}"
        )
        return None

    try:
        data = resp.json()
    except ValueError:
        app.logger.error(
            f"CDAC response not JSON emp_id={emp_id} body_snippet={(resp.text[:200])!r}")
        return None

    app.logger.info(f"CDAC lookup success emp_id={emp_id}")
    return data
