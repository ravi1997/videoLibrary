from flask_jwt_extended.exceptions import CSRFError, NoAuthorizationError, JWTExtendedException
from urllib.parse import unquote
from datetime import datetime
from flask import Blueprint, current_app, render_template, request, jsonify, abort, redirect, url_for
from app.config import Config
from app.models.User import User
from app.models.enumerations import Role
# TokenBlocklist removed in favor of unified tokens model
from app.models.video import Video, Category
from app.schemas.user_schema import UserSchema
from flask_jwt_extended import (
    create_access_token, jwt_required,
    get_jwt, set_access_cookies, unset_jwt_cookies, verify_jwt_in_request
)
from app.utils.decorator import require_roles
view_bp = Blueprint('view_bp', __name__)



ALL_ROLES = tuple(r.value for r in Role)


@view_bp.route('/<video_id>')
@jwt_required()
@require_roles(Role.VIEWER.value)
def video(video_id: str):
    """Video detail page.

    Only render if a video with the given UUID/string key exists; otherwise 404.
    Accepts raw or URL-encoded id.
    """
    vid = unquote(video_id or '').strip()
    if not vid:
        abort(404)

    # Basic sanity: UUIDs we generate are 36 chars (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    # but don't hard fail on length; still attempt lookup.
    video_obj = Video.query.filter_by(uuid=vid).first()
    if not video_obj:
        abort(404)

    return render_template('video.html', video_id=vid, video=video_obj)


@view_bp.route('/')
def index():
    try:
        verify_jwt_in_request()
    except NoAuthorizationError as e:
        current_app.logger.debug(f"Anonymous access to index page: {e}")
        return render_template('login.html')
    videos = Video.query.order_by(Video.created_at.desc()).all()
    return render_template('index.html', videos=videos)


@view_bp.route('/search')
@jwt_required()
@require_roles(Role.VIEWER.value)
def search_page():
    q = request.args.get('q', '')
    return render_template('search.html', q=q)


@view_bp.route('/upload')
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value, Role.SUPERADMIN.value)
def upload_page():
    return render_template('upload.html')


@view_bp.route('/login')
def login_page():
    return render_template('login.html')

@view_bp.route('/category/<category_name>')
@jwt_required()
@require_roles(Role.VIEWER.value)
def category_page(category_name: str):
    """Render category page only if category exists.

    Accepts either raw name or URL-encoded. Case-insensitive match.
    Returns 404 if no such category.
    """
    raw = unquote(category_name or '').strip()
    if not raw:
        abort(404)

    # Case-insensitive lookup
    category = Category.query.filter(Category.name.ilike(raw)).first()
    if not category:
        abort(404)

    return render_template('category.html', category=category.name)

@view_bp.route('/tag/<tag_name>')
@jwt_required()
@require_roles(Role.VIEWER.value)
def tag_page(tag_name: str):
    """Render tag page. The API endpoints require auth, but the page can render standalone."""
    # We don't validate existence here; the client will render based on API results
    return render_template('tag.html')

@view_bp.route('/favourites')
@jwt_required()
@require_roles(Role.VIEWER.value)
def favourites_page():
    return render_template('favourites.html')

@view_bp.route('/profile')
@jwt_required()
@require_roles(*ALL_ROLES)
def profile_page():
    return render_template('profile.html')


@view_bp.route('/settings')
@jwt_required()
@require_roles(*ALL_ROLES)
def settings_page():
    return render_template('settings.html')

@view_bp.route('/history')
@jwt_required()
@require_roles(Role.VIEWER.value)
def history_page():
    return render_template('history.html')

# Playlists
@view_bp.route('/playlists')
@jwt_required()
@require_roles(Role.VIEWER.value)
def playlists_page():
    return render_template('playlists.html')

@view_bp.route('/playlists/<int:pid>')
@jwt_required()
@require_roles(Role.VIEWER.value)
def playlist_detail_page(pid: int):
    return render_template('playlist_detail.html', pid=pid)

@view_bp.route('/playlist/<int:pid>/play')
@jwt_required()
@require_roles(Role.VIEWER.value)
def playlist_play_page(pid: int):
    return render_template('playlist_play.html', pid=pid)

# Video edit page (uploader/admin/superadmin)
@view_bp.route('/<video_id>/edit')
@jwt_required()
@require_roles(Role.UPLOADER.value, Role.ADMIN.value, Role.SUPERADMIN.value)
def video_edit_page(video_id):
    return render_template('video_edit.html', video_id=video_id)

@view_bp.route('/change-password')
@jwt_required()
@require_roles(*ALL_ROLES)
def change_password_page():
    return render_template('change-password.html')

@view_bp.route('/register')
def create_user_page():
    return render_template('register.html')

@view_bp.route('/forgot-password')
def forgot_password_page():
    return render_template('forgot_password.html')

@view_bp.route('/terms')
def terms_page():
    from datetime import timezone
    return render_template('terms.html', effective_date=datetime.now(timezone.utc).date())

@view_bp.route('/privacy')
def privacy_page():
    from datetime import timezone
    return render_template('privacy.html', effective_date=datetime.now(timezone.utc).date())

@view_bp.route('/admin/unverified')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def admin_unverified_page():  # injected by decorator
    return render_template('admin_unverified.html')

@view_bp.route('/admin/dashboard')        # canonical path
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def admin_dashboard_page():
    return render_template('admin_dashboard.html')


@view_bp.route('/linked-video/<int:surgeon_id>')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value,Role.VIEWER.value)
def linked_videos_page_alias_surgeon(surgeon_id):
    """Alias route so frontend can link to /linked-video/<surgeon_id>."""
    return render_template('linked_videos.html', surgeon_id=surgeon_id, user_id=None)

@view_bp.route('/superadmin/overview')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def superadmin_overview_page():
    """Legacy/alternate path for superadmin overview.

    Preferred canonical endpoint: /admin/super/overview (super_bp.super_overview)

    We TRY to redirect there to avoid duplication. However, during early app
    initialization (or if blueprint registration order changes) the canonical
    endpoint name might not yet exist, which previously caused a template
    render without required context (metrics) leading to 'metrics is undefined'.

    Fallback strategy:
      1. Attempt redirect to canonical route.
      2. If that fails (BuildError) OR explicit query param fallback=1 provided,
         compute a minimal metric snapshot inline and render template so page
         still loads (audit log list + full metrics are only available via the
         canonical route).
    """
    from werkzeug.routing import BuildError
    # Allow manual fallback testing: /superadmin/overview?fallback=1
    force_fallback = request.args.get('fallback') == '1'
    if not force_fallback:
        try:
            # Updated endpoint to existing canonical view_bp route
            return redirect(url_for('view_bp.super_overview_full'))
        except BuildError:
            pass  # proceed to lightweight fallback

    # ---- Lightweight fallback (no audit logs, minimal counts) ----
    try:
        users_count = User.query.count()
    except Exception:
        users_count = 0
    try:
        videos_count = Video.query.count()
    except Exception:
        videos_count = 0
    # Provide the minimal structure template expects
    minimal_metrics = {
        'users': users_count,
        'admins': None,
        'superadmins': None,
        'videos': videos_count,
        'favourites': None,
    }
    # maintenance_mode default off if not available
    maintenance_mode = 'off'
    try:
        from app.models import SystemSetting
        maintenance_mode = SystemSetting.get('maintenance_mode', 'off')
    except Exception:
        pass
    # Template expects audit_logs iterable
    return render_template('super_overview.html',
                           metrics=minimal_metrics,
                           audit_logs=[],
                           maintenance_mode=maintenance_mode,
                           fallback=True)

# Canonical superadmin overview page (moved from superadmin_route)
@view_bp.route('/admin/super/overview')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_overview_full():
    from app.routes.v1.superadmin_route import build_super_overview_context
    ctx = build_super_overview_context()
    return render_template('super_overview.html', **ctx)

@view_bp.route('/admin/super/audit')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_audit_page():
    """Superadmin audit log exploration page.

    Uses same underlying API endpoints (/api/v1/super/audit/list & export).
    We only seed initial recent logs (e.g., 50) for fast first paint.
    """
    from app.models import AuditLog
    # Seed recent logs (limit 50) similar to overview page
    recent = AuditLog.query.order_by(AuditLog.id.desc()).limit(50).all()
    return render_template('super_audit.html', audit_logs=[a.to_dict() for a in recent])

@view_bp.route('/admin/link-surgeons')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def link_surgeons_page():
    return render_template('link_surgeons.html')

@view_bp.route('/admin/linked-videos')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def linked_videos_page():
    surgeon_id = request.args.get('surgeon_id')
    user_id = request.args.get('user_id')
    return render_template('linked_videos.html', surgeon_id=surgeon_id, user_id=user_id)

@view_bp.route('/admin/super/users')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def superadmin_users_management_page():
    """Superadmin user management SPA-like page (fetches data via /api/v1/super/users)."""
    return render_template('super_users.html')

@view_bp.route('/admin/super/users/<user_id>/activity')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def superadmin_user_activity_page(user_id):
    # Template will fetch data via API; only pass id
    return render_template('user_activity.html', user_id=user_id)
