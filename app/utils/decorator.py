import logging
from functools import wraps
from flask import jsonify,current_app
from flask_jwt_extended import get_jwt, verify_jwt_in_request


def require_roles(*allowed_roles: str, require_all: bool = False):
    """
    Decorator to enforce role-based access using flask_jwt_extended.

    Args:
        allowed_roles: One or more role names allowed to access the route.
        require_all: If True, all roles must be present in user JWT. 
                     If False, any one of the allowed roles is sufficient.

    Example:
        @require_roles('admin')
        @require_roles('editor', 'publisher', require_all=True)
    """
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            try:
                current_app.logger.debug(
                    f"🔐 Checking access. Required roles: {allowed_roles}, require_all={require_all}"
                )
                verify_jwt_in_request()
                jwt_data = get_jwt()
                user_id = jwt_data.get('sub', 'unknown')
                user_roles = jwt_data.get('roles', [])

                if not user_roles:
                    current_app.logger.warning(
                        f"❌ Access denied. User {user_id} has no roles.")
                    return jsonify({'error': 'Unauthorized - No roles found'}), 401

                if require_all:
                    has_access = all(
                        role in user_roles for role in allowed_roles)
                else:
                    has_access = any(
                        role in user_roles for role in allowed_roles)

                if not has_access:
                    current_app.logger.warning(
                        f"🚫 Forbidden. User {user_id} roles: {user_roles}, required: {allowed_roles}"
                    )
                    return jsonify({'error': 'Forbidden: insufficient permissions'}), 403

                current_app.logger.debug(f"✅ Access granted to user {user_id}")
                return func(user_id,*args, **kwargs)

            except Exception as e:
                current_app.logger.exception(
                    "❗Error in role-based access control.")
                return jsonify({'error': 'Internal server error'}), 500

        return wrapper
    return decorator
