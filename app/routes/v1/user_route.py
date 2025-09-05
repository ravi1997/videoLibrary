# routes/user_routes.py

import traceback
from flask import Blueprint, request, jsonify, session, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity
from app.schemas.user_schema import UserSchema, UserSettingsSchema
from app.utils.decorator import require_roles
from app.models.User import User, UserSettings, UserType, Role, MAX_OTP_RESENDS, PASSWORD_EXPIRATION_DAYS
from app.security_utils import rate_limit, ip_and_path_key
from functools import wraps
from datetime import datetime, timedelta, timezone
import uuid
from app.extensions import db
from sqlalchemy.exc import SQLAlchemyError
user_bp = Blueprint("user_bp", __name__)

# ─── Auth Endpoints ─────────────────────────────────────


@user_bp.route("/change-password", methods=["POST","PUT"])
@jwt_required()
@rate_limit(ip_and_path_key, limit=5, window_sec=900)
def change_password():
    data = request.json or {}
    user_id = get_jwt_identity()
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    if not user.check_password(data.get("current_password", "")):
        return jsonify({"message": "Current password incorrect"}), 400
    try:
        user.set_password(data.get("new_password"))
    except ValueError as ve:
        return jsonify({"message": str(ve)}), 400
    db.session.commit()
    return jsonify({"message": "Password changed"}), 200


@user_bp.route("/reset-password", methods=["POST"])
def reset_password():
    data = request.json or {}
    user = None
    if data.get("otp"):
        user = User.objects(mobile=data.get("mobile")).first()
        if not user or not user.verify_otp(data["otp"]):
            return jsonify({"message": "Invalid OTP"}), 400
    else:
        user = User.objects(id=data.get("user_id")).first()

    if not user:
        return jsonify({"message": "User not found"}), 404

    user.set_password(data.get("new_password"))
    user.save()
    return jsonify({"message": "Password reset"}), 200


@user_bp.route("/unlock", methods=["POST"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def auth_unlock():
    data = request.json or {}
    user = User.objects(id=data.get("user_id")).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    user.unlock_account()
    return jsonify({"message": f"User {user.id} unlocked"}), 200


@user_bp.route("/status", methods=["GET"])
@jwt_required()
def auth_status():
    user_id = get_jwt_identity()
    user = User.query.filter_by(id=user_id).first()
    return jsonify({"user": UserSchema().dump(user) if user else None}), 200

# ─── CRUD Endpoints ─────────────────────────────────────


@user_bp.route("/users", methods=["GET"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def list_users():
    users = User.query.order_by(User.created_at.asc()).all()
    return jsonify([u.to_dict() for u in users]), 200


@user_bp.route("/users/<user_id>", methods=["GET"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def get_user(user_id):
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    return jsonify(user.to_dict()), 200


@user_bp.route("/users", methods=["POST"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def create_user():
    data = request.get_json(force=True, silent=True) or {}
    password = data.pop("password", None)
    try:
        user = User(**data)
        if password:
            user.set_password(password)
        db.session.add(user)
        db.session.commit()
        return jsonify(user.to_dict()), 201
    except ValueError as ve:
        db.session.rollback()
        return jsonify({"message": str(ve)}), 400
    except Exception:
        db.session.rollback()
        current_app.logger.exception("create_user failed")
        return jsonify({"message": "Internal error"}), 500


@user_bp.route("/users/<user_id>", methods=["PUT"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def update_user(user_id):
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    data = request.json or {}
    for k, v in (data or {}).items():
        if k == 'password_hash':
            continue
        if hasattr(user, k):
            setattr(user, k, v)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"message": "Update failed"}), 500
    return jsonify(user.to_dict()), 200


@user_bp.route("/users/<user_id>", methods=["DELETE"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def delete_user(user_id):
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    try:
        db.session.delete(user)
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"message": "Delete failed"}), 500
    return jsonify({"message": "User deleted"}), 200


@user_bp.route("/users/<user_id>/lock", methods=["POST"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def lock_user(user_id):
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    user.lock_account()
    db.session.commit()
    return jsonify({"message": f"User {user.id} locked"}), 200


@user_bp.route("/users/<user_id>/unlock", methods=["POST"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def unlock_user(user_id):
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    user.unlock_account()
    db.session.commit()
    return jsonify({"message": f"User {user.id} unlocked"}), 200


@user_bp.route("/users/<user_id>/reset-otp-count", methods=["POST"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def reset_otp_count(user_id):
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    user.otp_resend_count = 0
    db.session.commit()
    return jsonify({"message": f"OTP count reset for {user.id}"}), 200

# ─── Security Endpoints ─────────────────────────────────


@user_bp.route("/security/extend-password-expiry", methods=["POST"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def extend_password_expiry():
    data = request.json or {}
    uid = data.get("user_id")
    days = data.get("days", PASSWORD_EXPIRATION_DAYS)
    user = User.query.filter_by(id=uid).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    user.password_expiration = datetime.now(timezone.utc) + timedelta(days=days)
    db.session.commit()
    return jsonify({"message": "Password expiry extended"}), 200


@user_bp.route("/security/lock-status/<user_id>", methods=["GET"])
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def lock_status(user_id):
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    return jsonify({"locked": user.is_locked()}), 200


@user_bp.route("/security/resend-otp", methods=["POST"])
@rate_limit(ip_and_path_key, limit=5, window_sec=600)
def resend_otp():
    data = request.get_json(force=True, silent=True) or {}
    mobile = data.get("mobile")
    user = User.query.filter_by(mobile=mobile).first()
    if not user:
        return jsonify({"message": "User not found"}), 404
    if user.is_locked():
        return jsonify({"message": "Account locked"}), 403
    user.resend_otp()
    db.session.commit()
    payload = {"message": "OTP resent"}
    if current_app.config.get("DEBUG"):
        payload["otp"] = user.otp
    return jsonify(payload), 200


DEFAULTS = {
    "theme": "system",
    "compact": False,
    "autoplay": False,
    "quality": "auto",
    "speed": "1.0",
    "email_updates": False,
    "weekly_digest": False,
    "private_profile": False,
    "personalize": True,
}


def _get_or_create_user_settings(user_id: int) -> UserSettings:
    inst = db.session.get(UserSettings, user_id)
    if inst is None:
        inst = UserSettings(user_id=user_id, **DEFAULTS)
        db.session.add(inst)
        db.session.commit()
    return inst


@user_bp.get("/settings")
@jwt_required()
def get_settings():
    """Return current user's settings, creating defaults if missing."""
    user_id = get_jwt_identity()
    user_settings_schema = UserSettingsSchema()
    inst = _get_or_create_user_settings(user_id)
    return user_settings_schema.dump(inst), 200


@user_bp.put("/settings")
@jwt_required()
def put_settings():
    """
    Update current user's settings.
    Accepts partial JSON. Unknown fields are ignored by the schema.
    """
    user_id = get_jwt_identity()
    inst = _get_or_create_user_settings(user_id)
    user_settings_schema = UserSettingsSchema(session=db.session)
    # Load/validate partial update into the existing instance
    payload = request.get_json(force=True, silent=True) or {}
    try:
        # `partial=True` allows sending only changed fields
        inst = user_settings_schema.load(payload, instance=inst, partial=True)

        db.session.add(inst)
        db.session.commit()
    except SQLAlchemyError as e:
        db.session.rollback()
        return jsonify({"error": "database_error", "detail": str(e), "traceback": traceback.format_exc()}), 500
    except Exception as e:
        # Marshmallow validation errors arrive as `ValidationError`
        # which has `.messages`, but falling back to str(e) is OK
        return jsonify({"error": "validation_error", "detail": str(e)}), 400

    return user_settings_schema.jsonify(inst), 200
