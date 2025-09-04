from flask import current_app as app
import requests
from typing import Optional

SMS_DEFAULT_ENDPOINT = "https://rpcapplication.aiims.edu/services/api/v1/sms/single"


def send_sms(mobile: str, message: str) -> int:
    """
    Send an SMS via REST JSON endpoint.

    Args:
        mobile: Recipient mobile number (E.164 or local as accepted by provider).
        message: Text message content.

    Returns:
        HTTP status code from upstream (200 expected on success) or:
        400 for local validation failure,
        500 for internal/request exception,
        503 when service disabled.
    """
    if not mobile or not message:
        app.logger.warning("send_sms: missing mobile or message")
        return 400

    # Feature flag: if OTP_FLAG disabled, skip real send
    if not app.config.get("OTP_FLAG", True):
        app.logger.info(
            "send_sms: skipped (OTP_FLAG disabled) mobile=%s msg=%r", mobile, message)
        return 200

    url = app.config.get("SMS_API_URL", SMS_DEFAULT_ENDPOINT)
    token = (
        app.config.get("SMS_API_TOKEN")
    )

    if not token:
        app.logger.error(
            "send_sms: missing API token (SMS_API_TOKEN)")
        return 503

    payload = {
        "mobile": mobile,
        "message": message,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    try:
        app.logger.debug("send_sms: POST %s payload=%s", url, payload)
        resp = requests.post(url, json=payload, headers=headers, timeout=10)
    except requests.RequestException as exc:
        app.logger.error(
            "send_sms: request exception mobile=%s err=%s", mobile, exc, exc_info=True)
        return 500

    if resp.status_code != 200:
        snippet = (resp.text or "")[:300]
        app.logger.warning(
            "send_sms: upstream failure status=%s body=%r mobile=%s",
            resp.status_code,
            snippet,
            mobile,
        )
    else:
        app.logger.info("send_sms: sent mobile=%s status=%s",
                        mobile, resp.status_code)
    return resp.status_code
