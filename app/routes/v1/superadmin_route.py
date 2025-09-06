import os
from datetime import datetime, timedelta, timezone
from flask import Blueprint, jsonify, request, current_app
from flask_jwt_extended import jwt_required
from sqlalchemy import func, inspect

from app.extensions import db
from app.models import User, Video
from app.models.User import UserRole
from app.models.video import Favourite
from app.models.enumerations import Role
from app.utils.decorator import require_roles
from app.security_utils import audit_log

# Only API blueprint (page route moved to view_route view_bp)
super_api_bp = Blueprint('super_api_bp', __name__)

def build_super_overview_context():
    from app.models import AuditLog, SystemSetting
    now = datetime.utcnow()
    # Basic aggregated metrics
    total_users = User.query.count()
    admins = db.session.query(UserRole).filter(UserRole.role == Role.ADMIN).count()
    superadmins = db.session.query(UserRole).filter(UserRole.role == Role.SUPERADMIN).count()
    videos_total = Video.query.count()
    favourites_total = Favourite.query.count()
    last_audit = AuditLog.query.order_by(AuditLog.id.desc()).limit(10).all()
    maintenance = SystemSetting.get('maintenance_mode', 'off')
    maintenance_reason = SystemSetting.get('maintenance_mode_reason', '')

    # Security: failed logins & locked accounts
    day_ago = now - timedelta(hours=24)
    failed_recent = User.query.filter(User.failed_login_attempts > 0, User.updated_at >= day_ago).count()
    locked_accounts = User.query.filter(User.lock_until.isnot(None), User.lock_until > now).count()
    soon = now + timedelta(hours=2)
    soon_unlock = User.query.filter(User.lock_until.isnot(None), User.lock_until <= soon, User.lock_until > now).order_by(User.lock_until.asc()).limit(5).all()
    soon_unlock_list = [ {'id': str(u.id), 'username': u.username, 'unlock_at': u.lock_until.isoformat()} for u in soon_unlock ]

    # Password age for superadmin(s)
    superadmin_users = User.query.join(UserRole).filter(UserRole.role == Role.SUPERADMIN).all()
    pwd_status = []
    for su in superadmin_users:
        expires_in = None
        if su.password_expiration:
            exp = su.password_expiration
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            delta = exp - datetime.now(timezone.utc)
            expires_in = int(delta.total_seconds())
        pwd_status.append({'id': str(su.id), 'username': su.username, 'expires_in_seconds': expires_in})

    # Growth: user signups & video uploads (daily counts last 90)
    ninety_days_ago = now - timedelta(days=90)
    signup_rows = db.session.query(func.date(User.created_at).label('d'), func.count(User.id)). \
        filter(User.created_at >= ninety_days_ago).group_by(func.date(User.created_at)).order_by(func.date(User.created_at)).all()
    signup_series = [ {'day': d.isoformat() if hasattr(d, 'isoformat') else str(d), 'count': c} for d, c in signup_rows ]
    upload_rows = db.session.query(func.date(Video.created_at).label('d'), func.count(Video.uuid)). \
        filter(Video.created_at >= ninety_days_ago).group_by(func.date(Video.created_at)).order_by(func.date(Video.created_at)).all()
    upload_series = [ {'day': d.isoformat() if hasattr(d, 'isoformat') else str(d), 'count': c} for d, c in upload_rows ]

    # Top viewed videos created in last 24h
    recent_videos = Video.query.filter(Video.created_at >= day_ago).order_by(Video.views.desc()).limit(5).all()
    top_recent_views = [ {'uuid': v.uuid, 'title': v.title, 'views': v.views} for v in recent_videos ]

    # Alembic migration status: current vs head
    alembic_current = None
    alembic_head = None
    try:
        insp = inspect(db.engine)
        if 'alembic_version' in insp.get_table_names():
            version_row = db.session.execute(db.text('SELECT version_num FROM alembic_version')).fetchone()
            if version_row:
                alembic_current = version_row[0]
            try:
                from alembic.config import Config as AlembicConfig
                from alembic.script import ScriptDirectory
                alembic_ini = os.path.join(current_app.root_path, '..', 'migrations', 'alembic.ini')
                if not os.path.exists(alembic_ini):
                    alembic_ini = os.path.join(current_app.root_path, 'migrations', 'alembic.ini')
                if os.path.exists(alembic_ini):
                    acfg = AlembicConfig(alembic_ini)
                    script_dir = ScriptDirectory.from_config(acfg)
                    alembic_head = script_dir.get_current_head()
            except Exception:
                pass
    except Exception:
        pass

    migration_drift = None
    if alembic_current and alembic_head and alembic_current != alembic_head:
        migration_drift = {'current': alembic_current, 'head': alembic_head}

    active_users_count = User.query.filter(User.is_active.is_(True)).count()
    inactive_users_count = total_users - active_users_count

    # Audit event frequency last 24h (top 5)
    events_24h = []
    try:
        from app.models import AuditLog
        since = now - timedelta(hours=24)
        event_rows = db.session.query(AuditLog.event, func.count(AuditLog.id)). \
            filter(AuditLog.created_at >= since).group_by(AuditLog.event).order_by(func.count(AuditLog.id).desc()).limit(5).all()
        events_24h = [ {'event': e, 'count': c} for e, c in event_rows ]
    except Exception:
        pass

    # Anomaly detection (failed login spike)
    anomaly = None
    try:
        from app.models import AuditLog
        last_hour_start = now - timedelta(hours=1)
        baseline_start = now - timedelta(hours=25)
        baseline_total = db.session.query(func.count(AuditLog.id)). \
            filter(AuditLog.event == 'login_failed', AuditLog.created_at >= baseline_start, AuditLog.created_at < last_hour_start).scalar() or 0
        current_total = db.session.query(func.count(AuditLog.id)). \
            filter(AuditLog.event == 'login_failed', AuditLog.created_at >= last_hour_start).scalar() or 0
        baseline_rate = baseline_total / 24.0
        spike = current_total > max(5, baseline_rate * 2.5)
        anomaly = {
            'failed_login_spike': bool(spike),
            'current_per_hour': current_total,
            'baseline_per_hour': round(baseline_rate, 2)
        }
    except Exception:
        pass

    git_revision = None
    try:
        git_dir = os.path.join(current_app.root_path, '..', '.git')
        if not os.path.isdir(git_dir):
            git_dir = os.path.join(current_app.root_path, '.git')
        head_file = os.path.join(git_dir, 'HEAD')
        if os.path.exists(head_file):
            with open(head_file, 'r') as f:
                head_ref = f.read().strip()
            if head_ref.startswith('ref:'):
                ref_path = head_ref.split(' ',1)[1]
                ref_file = os.path.join(git_dir, ref_path)
                if os.path.exists(ref_file):
                    with open(ref_file,'r') as rf:
                        git_revision = rf.read().strip()[:12]
            else:
                git_revision = head_ref[:12]
    except Exception:
        pass

    jwt_access_ttl_min = None
    try:
        exp = current_app.config.get('JWT_ACCESS_TOKEN_EXPIRES')
        if exp:
            jwt_access_ttl_min = int(exp.total_seconds()//60)
    except Exception:
        pass
    refresh_ttl_min = current_app.config.get('REFRESH_TOKEN_EXPIRES_MINUTES')
    environment_name = current_app.config.get('MY_ENVIRONMENT')

    metrics = {
        'users': total_users,
        'admins': admins,
        'superadmins': superadmins,
        'videos': videos_total,
        'favourites': favourites_total,
        'user_activity': {
            'active': active_users_count,
            'inactive': inactive_users_count,
            'active_pct': (active_users_count/total_users*100.0) if total_users else 0.0
        },
        'security': {
            'failed_login_recent_24h': failed_recent,
            'locked_accounts': locked_accounts,
            'soon_to_unlock': soon_unlock_list,
            'superadmin_passwords': pwd_status,
            'anomaly': anomaly
        },
        'growth': {
            'signups_90d': signup_series,
            'uploads_90d': upload_series,
            'top_recent_24h': top_recent_views
        },
        'migrations': {
            'current': alembic_current,
            'head': alembic_head,
            'drift': migration_drift
        },
        'audit_events_24h_top': events_24h,
        'system': {
            'git_revision': git_revision,
            'environment': environment_name,
            'jwt_access_ttl_min': jwt_access_ttl_min,
            'refresh_ttl_min': refresh_ttl_min
        }
    }

    return {
        'metrics': metrics,
        'audit_logs': [a.to_dict() for a in last_audit],
        'maintenance_mode': maintenance,
        'maintenance_reason': maintenance_reason
    }

@super_api_bp.post('/maintenance')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def toggle_maintenance():
    from app.models import SystemSetting
    from app.security_utils import audit_log
    data = request.get_json(force=True, silent=True) or {}
    mode = (data.get('mode') or 'off').lower()
    reason = (data.get('reason') or '').strip()
    if mode not in ('on','off'):
        return jsonify({'error':'invalid_mode'}), 400
    SystemSetting.set('maintenance_mode', mode)
    if reason or mode == 'off':
        SystemSetting.set('maintenance_mode_reason', '' if mode == 'off' else reason[:256])
    audit_log('maintenance_mode_set', detail=f'mode={mode}')
    return jsonify({'status':'ok','mode':mode,'reason': SystemSetting.get('maintenance_mode_reason','')})

@super_api_bp.get('/audit/export')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def export_audit():
    from app.models import AuditLog
    qs = AuditLog.query.order_by(AuditLog.id.desc()).limit(500)
    rows = [a.to_dict() for a in qs]
    return jsonify({'items': rows, 'count': len(rows)})

@super_api_bp.get('/audit/list')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def list_audit():
    from app.models import AuditLog
    event = (request.args.get('event') or '').strip()
    user_id = (request.args.get('user_id') or '').strip()
    target_id = (request.args.get('target_user_id') or '').strip()
    limit = min(200, max(1, int(request.args.get('limit', 50) or 50)))
    offset = max(0, int(request.args.get('offset', 0) or 0))
    q = AuditLog.query
    if event:
        q = q.filter(AuditLog.event == event)
    if user_id:
        q = q.filter(AuditLog.user_id == user_id)
    if target_id:
        q = q.filter(AuditLog.target_user_id == target_id)
    total = q.count()
    items = q.order_by(AuditLog.id.desc()).offset(offset).limit(limit).all()
    return jsonify({'items': [a.to_dict() for a in items], 'total': total, 'limit': limit, 'offset': offset})

# (Page route now lives in view_route)

@super_api_bp.get('/users')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_list_users():
    """List users with filtering, sorting, pagination for management UI."""
    q = (request.args.get('q') or '').strip().lower()
    role_filter = (request.args.get('role') or '').strip().lower()  # role value
    active_filter = (request.args.get('active') or '').strip().lower()  # yes|no
    locked_filter = (request.args.get('locked') or '').strip().lower()  # yes|no
    verified_filter = (request.args.get('verified') or '').strip().lower()  # yes|no
    sort_by = (request.args.get('sort_by') or 'created_at').lower()
    sort_dir = (request.args.get('sort_dir') or 'desc').lower()
    page = max(1, int(request.args.get('page', 1) or 1))
    page_size = min(100, max(1, int(request.args.get('page_size', 25) or 25)))

    base = User.query
    if q:
        like = f"%{q}%"
        base = base.filter(db.or_(User.username.ilike(like), User.email.ilike(like), User.employee_id.ilike(like)))
    if role_filter:
        base = base.join(UserRole).filter(UserRole.role == role_filter)
    if active_filter == 'yes':
        base = base.filter(User.is_active.is_(True))
    elif active_filter == 'no':
        base = base.filter(User.is_active.is_(False))
    if locked_filter == 'yes':
        base = base.filter(User.lock_until.isnot(None))
    elif locked_filter == 'no':
        base = base.filter(User.lock_until.is_(None))
    if verified_filter == 'yes':
        base = base.filter(User.is_verified.is_(True))
    elif verified_filter == 'no':
        base = base.filter(User.is_verified.is_(False))

    allowed_sort = {
        'username': User.username,
        'email': User.email,
        'created_at': User.created_at,
        'last_login': User.last_login,
        'failed_login_attempts': User.failed_login_attempts
    }
    sort_col = allowed_sort.get(sort_by, User.created_at)
    if sort_dir == 'desc':
        sort_col = sort_col.desc()

    total = base.count()
    rows = base.order_by(sort_col).offset((page-1)*page_size).limit(page_size).all()
    pages = max(1, (total + page_size - 1)//page_size)
    out = [u.to_dict() for u in rows]
    return jsonify({'items': out, 'page': page, 'pages': pages, 'total': total})

@super_api_bp.get('/users/<uid>')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_get_user(uid):
    user = User.query.get(uid)
    if not user:
        return jsonify({'error': 'not_found'}), 404
    return jsonify({'user': user.to_dict(include_sensitive=False)}), 200

@super_api_bp.post('/users/<uid>/roles')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_update_user_roles(uid):
    data = request.get_json(force=True, silent=True) or {}
    roles_in = data.get('roles') or []
    valid_roles = {r.value for r in Role}
    clean = []
    for r in roles_in:
        rv = (r or '').strip().lower()
        if rv in valid_roles:
            clean.append(rv)
    user = User.query.get(uid)
    if not user:
        return jsonify({'error': 'not_found'}), 404
    user.role_associations.clear()
    for rv in clean:
        user.role_associations.append(UserRole(user_id=user.id, role=Role(rv)))
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('user_roles_updated', target_user_id=uid, detail=','.join([r.value for r in user.roles]))
    return jsonify({'status': 'ok', 'roles': [r.value for r in user.roles]})

@super_api_bp.post('/users/<uid>/lock')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_lock_user(uid):
    user = User.query.get(uid)
    if not user:
        return jsonify({'error': 'not_found'}), 404
    user.lock_account()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('user_locked', target_user_id=uid)
    return jsonify({'status': 'ok', 'lock_until': user.lock_until.isoformat() if user.lock_until else None})

@super_api_bp.post('/users/<uid>/unlock')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_unlock_user(uid):
    user = User.query.get(uid)
    if not user:
        return jsonify({'error': 'not_found'}), 404
    try:
        user.unlock_account()
    except Exception:
        current_app.logger.exception('super_unlock_user: SMS send failed')
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('user_unlocked', target_user_id=uid, detail='password_reset_forced_change')
    return jsonify({'status': 'ok', 'temporary_password_sent': bool(user.mobile)})

@super_api_bp.post('/users/<uid>/activate')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_activate_user(uid):
    user = User.query.get(uid)
    if not user:
        return jsonify({'error': 'not_found'}), 404
    user.is_active = True
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('user_activated', target_user_id=uid)
    return jsonify({'status': 'ok', 'is_active': True})

@super_api_bp.post('/users/<uid>/deactivate')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_deactivate_user(uid):
    user = User.query.get(uid)
    if not user:
        return jsonify({'error': 'not_found'}), 404
    user.is_active = False
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('user_deactivated', target_user_id=uid)
    return jsonify({'status': 'ok', 'is_active': False})

@super_api_bp.post('/users/bulk/roles')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_bulk_set_roles():
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get('user_ids') or []
    roles_in = data.get('roles') or []
    valid_roles = {r.value for r in Role}
    clean_roles = [r for r in [ (ri or '').strip().lower() for ri in roles_in ] if r in valid_roles]
    updated = 0
    users = User.query.filter(User.id.in_(ids)).all() if ids else []
    for u in users:
        u.role_associations.clear()
        for rv in clean_roles:
            u.role_associations.append(UserRole(user_id=u.id, role=Role(rv)))
        updated += 1
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('bulk_roles_update', detail=f"count={updated};roles={','.join(clean_roles)}")
    return jsonify({'status': 'ok', 'updated': updated})

@super_api_bp.post('/users/bulk/lock')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_bulk_lock():
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get('user_ids') or []
    users = User.query.filter(User.id.in_(ids)).all() if ids else []
    for u in users:
        u.lock_account()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('bulk_user_lock', detail=f"count={len(users)}")
    return jsonify({'status': 'ok', 'locked': len(users)})

@super_api_bp.post('/users/bulk/unlock')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_bulk_unlock():
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get('user_ids') or []
    users = User.query.filter(User.id.in_(ids)).all() if ids else []
    for u in users:
        u.unlock_account()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('bulk_user_unlock', detail=f"count={len(users)}")
    return jsonify({'status': 'ok', 'unlocked': len(users)})

@super_api_bp.post('/users/bulk/activate')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_bulk_activate():
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get('user_ids') or []
    users = User.query.filter(User.id.in_(ids)).all() if ids else []
    for u in users:
        u.is_active = True
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('bulk_user_activate', detail=f"count={len(users)}")
    return jsonify({'status': 'ok', 'activated': len(users)})

@super_api_bp.post('/users/bulk/deactivate')
@jwt_required()
@require_roles(Role.SUPERADMIN.value)
def super_bulk_deactivate():
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get('user_ids') or []
    users = User.query.filter(User.id.in_(ids)).all() if ids else []
    for u in users:
        u.is_active = False
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'error': 'persist_failed'}), 500
    audit_log('bulk_user_deactivate', detail=f"count={len(users)}")
    return jsonify({'status': 'ok', 'deactivated': len(users)})
