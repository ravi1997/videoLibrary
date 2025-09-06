"""Audit & admin helper utilities to reduce duplication."""
from typing import Optional, Iterable, Callable, Any, Dict
from app.security_utils import audit_log
from app.extensions import db


LOGIN_FAIL_DETAILS = {
    'user_not_found', 'not_verified', 'bad_password', 'otp_user_not_found',
    'otp_invalid', 'otp_not_verified', 'general_used_password_flow'
}

def log_login_failed(detail: str, target_user_id: Optional[str] = None):
    """Standardize login_failed audit events.

    Unknown details are coerced to 'other'.
    """
    if detail not in LOGIN_FAIL_DETAILS:
        detail = 'other'
    audit_log('login_failed', target_user_id=target_user_id, detail=detail)


def bulk_user_mutation(users: Iterable[Any],
                       mutate: Callable[[Any], None],
                       audit_event: str,
                       detail_fmt: Optional[str] = None,
                       continue_on_error: bool = False) -> Dict[str, Any]:
    """Apply a mutation function to each user, commit once, and audit.

    Args:
        users: iterable of user objects
        mutate: function applying mutation to a user (in-place)
        audit_event: audit event name to emit when at least one user changed
        detail_fmt: optional format string using {count}
        continue_on_error: if True, exceptions per-user are logged and processing continues

    Returns summary dict. Rolls back whole batch if commit fails. Skips audit when count=0.
    """
    count = 0
    failures = 0
    for u in users:
        try:
            mutate(u)
            count += 1
        except Exception:
            if not continue_on_error:
                raise
            failures += 1
    if count == 0:
        return {'status': 'ok', 'count': 0, 'skipped': True}
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return {'error': 'persist_failed'}
    detail = (detail_fmt or 'count={count}').format(count=count)
    audit_log(audit_event, detail=detail)
    out = {'status': 'ok', 'count': count}
    if failures:
        out['failures'] = failures
    return out
