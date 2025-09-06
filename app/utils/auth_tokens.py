"""Auth token helpers.

Centralizes access token creation so claims stay consistent across login & refresh.
"""
from datetime import timedelta
from flask_jwt_extended import create_access_token


def issue_access_token(user):
    """Return a newly created access token for a user.

    Adds standard claims:
      - roles: list of role values
      - pwd_change: boolean flag if password change is required (if attribute exists)
    """
    # Collect roles (avoid triggering lazy loads repeatedly)
    roles = [ur.role.value for ur in getattr(user, 'role_associations', [])]
    pwd_change = bool(getattr(user, 'require_password_change', False))
    return create_access_token(
        identity=str(user.id),
        additional_claims={
            'roles': roles,
            'pwd_change': pwd_change
        }
    )
