from datetime import datetime, timedelta, timezone
from flask import Blueprint, jsonify, request, current_app
from flask_jwt_extended import jwt_required
from sqlalchemy import func

from app.extensions import db
from app.security_utils import coerce_uuid
from app.models import User, Surgeon, Video, VideoSurgeon, Token
from app.models.video import VideoViewEvent
from app.models.User import UserRole
from app.models.video import Favourite
from app.models.enumerations import Role
from app.utils.decorator import require_roles
from app.utils.api_helper import parse_pagination_params, build_page_dict
from app.utils import metrics_cache

"""Administrative API routes (HTML page routes moved to view_bp).

Previously this module also exposed a page-rendering blueprint (admin_pages_bp)
for routes like /admin/link-surgeons and /admin/dashboard. Per refactor goals
these HTML endpoints now live under the central view_bp in
app.routes.v1.view_route to consolidate template handling. This file now only
defines JSON/REST style API endpoints. The blueprint is registered with its
URL prefix in app.routes.__init__.register_blueprints (no inline prefix here).
"""

admin_api_bp = Blueprint('admin_api_bp', __name__)

@admin_api_bp.get('/surgeons')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def list_surgeons():
    q = (request.args.get('q') or '').strip().lower()
    page, page_size = parse_pagination_params()
    link_filter = (request.args.get('linked') or '').lower()
    sort_by = (request.args.get('sort_by') or 'id').lower()
    sort_dir = (request.args.get('sort_dir') or 'asc').lower()
    allowed_sort = {
        'id': Surgeon.id,
        'name': Surgeon.name,
        'type': Surgeon.type
    }
    sort_col = allowed_sort.get(sort_by, Surgeon.id)
    if sort_dir == 'desc':
        sort_col = sort_col.desc()

    surgeons_q = Surgeon.query
    if q:
        surgeons_q = surgeons_q.filter(Surgeon.name.ilike(f'%{q}%'))
    if link_filter == 'yes':
        surgeons_q = surgeons_q.filter(Surgeon.user_id.isnot(None))
    elif link_filter == 'no':
        surgeons_q = surgeons_q.filter(Surgeon.user_id.is_(None))
    total = surgeons_q.count()
    surgeons = surgeons_q.order_by(sort_col).offset((page-1)*page_size).limit(page_size).all()
    linked_count = Surgeon.query.filter(Surgeon.user_id.isnot(None)).count()
    unlinked_count = Surgeon.query.filter(Surgeon.user_id.is_(None)).count()
    out = []
    for s in surgeons:
        out.append({
            'id': s.id,
            'name': s.name,
            'type': s.type,
            'user_id': str(s.user_id) if s.user_id else None,
            'description': s.description or ''
        })
    page_dict = build_page_dict(out, page, page_size, total)
    page_dict['counts'] = {'linked': linked_count, 'unlinked': unlinked_count}
    return jsonify(page_dict)

@admin_api_bp.get('/users')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def list_users_for_link():
    q = (request.args.get('q') or '').strip().lower()
    page, page_size = parse_pagination_params()
    link_filter = (request.args.get('has_surgeon') or '').lower()
    sort_by = (request.args.get('sort_by') or 'created_at').lower()
    sort_dir = (request.args.get('sort_dir') or 'desc').lower()

    base_q = User.query
    if q:
        base_q = base_q.filter(User.username.ilike(f'%{q}%'))

    with_count = base_q.filter(User.surgeon != None).count()      # noqa: E711
    without_count = base_q.filter(User.surgeon == None).count()   # noqa: E711

    users_q = base_q
    if link_filter == 'yes':
        users_q = users_q.filter(User.surgeon != None)            # noqa: E711
    elif link_filter == 'no':
        users_q = users_q.filter(User.surgeon == None)            # noqa: E711

    allowed_sort = {
        'username': getattr(User, 'username'),
        'email': getattr(User, 'email'),
        'created_at': getattr(User, 'created_at', getattr(User, 'username'))
    }
    sort_col = allowed_sort.get(sort_by, allowed_sort['created_at'])
    if sort_dir == 'desc':
        sort_col = sort_col.desc()

    total = users_q.count()
    users_q = users_q.order_by(sort_col)
    users = users_q.offset((page-1)*page_size).limit(page_size).all()
    out = []
    for u in users:
        out.append({
            'id': str(u.id),
            'username': u.username,
            'email': u.email,
            'has_surgeon': bool(u.surgeon)
        })
    page_dict = build_page_dict(out, page, page_size, total)
    page_dict['counts'] = {'with': with_count, 'without': without_count}
    return jsonify(page_dict)

@admin_api_bp.post('/surgeons')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def create_surgeon():
    data = request.get_json(force=True)
    name = (data.get('name') or '').strip()
    stype = (data.get('type') or '').strip()
    desc = (data.get('description') or '').strip()
    if not name or not stype:
        return jsonify({'msg': 'name and type required'}), 400
    s = Surgeon(name=name, type=stype, description=desc)
    db.session.add(s)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'msg': 'persist failed'}), 500
    try:
        metrics_cache.invalidate()
    except Exception:
        pass
    return jsonify({'msg': 'created', 'id': s.id}), 201

@admin_api_bp.post('/surgeons/bulk/link')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def bulk_link_surgeons():
    data = request.get_json(force=True) or {}
    surgeon_ids = data.get('surgeon_ids') or []
    user_id = (data.get('user_id') or '').strip()
    if not surgeon_ids or not user_id:
        return jsonify({'msg': 'surgeon_ids and user_id required'}), 400
    user = db.session.get(User, coerce_uuid(user_id))
    if not user:
        return jsonify({'msg': 'user not found'}), 404
    updated = 0
    for sid in surgeon_ids:
        s = db.session.get(Surgeon, sid)
        if s:
            s.user_id = user.id
            updated += 1
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'msg': 'bulk persist failed'}), 500
    try:
        metrics_cache.invalidate()
    except Exception:
        pass
    return jsonify({'msg': 'bulk linked', 'count': updated, 'user_id': str(user.id)})

@admin_api_bp.post('/surgeons/bulk/unlink')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def bulk_unlink_surgeons():
    data = request.get_json(force=True) or {}
    surgeon_ids = data.get('surgeon_ids') or []
    if not surgeon_ids:
        return jsonify({'msg': 'surgeon_ids required'}), 400
    updated = 0
    for sid in surgeon_ids:
        s = db.session.get(Surgeon, sid)
        if s and s.user_id is not None:
            s.user_id = None
            updated += 1
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'msg': 'bulk persist failed'}), 500
    try:
        metrics_cache.invalidate()
    except Exception:
        pass
    return jsonify({'msg': 'bulk unlinked', 'count': updated})

@admin_api_bp.post('/surgeons/<int:sid>/link')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def link_surgeon_user(sid):
    data = request.get_json(force=True)
    user_id = (data.get('user_id') or '').strip()
    if not user_id:
        return jsonify({'msg': 'user_id required'}), 400
    surgeon = db.session.get(Surgeon, sid)
    if not surgeon:
        return jsonify({'msg': 'surgeon not found'}), 404
    user = db.session.get(User, coerce_uuid(user_id))
    if not user:
        return jsonify({'msg': 'user not found'}), 404
    surgeon.user_id = user.id
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'msg': 'persist failed'}), 500
    try:
        metrics_cache.invalidate()
    except Exception:
        pass
    return jsonify({'msg': 'linked', 'surgeon_id': surgeon.id, 'user_id': str(user.id)})

@admin_api_bp.post('/surgeons/<int:sid>/unlink')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def unlink_surgeon_user(sid):
    surgeon = db.session.get(Surgeon, sid)
    if not surgeon:
        return jsonify({'msg': 'surgeon not found'}), 404
    surgeon.user_id = None
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'msg': 'persist failed'}), 500
    try:
        metrics_cache.invalidate()
    except Exception:
        pass
    return jsonify({'msg': 'unlinked', 'surgeon_id': surgeon.id})

@admin_api_bp.get('/surgeons/<int:sid>/detail')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def surgeon_detail(sid):
    s = db.session.get(Surgeon, sid)
    if not s:
        return jsonify({'msg': 'not found'}), 404
    user = None
    if s.user_id:
        u = db.session.get(User, s.user_id)
        if u:
            user = {'id': str(u.id), 'username': u.username, 'email': u.email}
    return jsonify({
        'id': s.id,
        'name': s.name,
        'type': s.type,
        'description': s.description or '',
        'user': user
    })

@admin_api_bp.get('/users/<uid>/surgeons')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def user_surgeons(uid):
    u = db.session.get(User, coerce_uuid(uid))
    if not u:
        return jsonify({'msg': 'not found'}), 404
    surgeons = Surgeon.query.filter(Surgeon.user_id == u.id).all()
    return jsonify({
        'user_id': str(u.id),
        'surgeons': [ {'id': s.id, 'name': s.name, 'type': s.type} for s in surgeons ]
    })

@admin_api_bp.get('/surgeons/<int:sid>/videos')
@jwt_required()
def surgeon_videos(sid):
    s = db.session.get(Surgeon, sid)
    if not s:
        return jsonify({'msg': 'not found'}), 404
    q = (request.args.get('q') or '').strip().lower()
    page, page_size = parse_pagination_params()
    sort_dir = (request.args.get('sort_dir') or 'desc').lower()
    surgeon_ids = [s.id]
    aggregated = False
    surgeon_group = []
    if s.user_id:
        group = Surgeon.query.filter(Surgeon.user_id == s.user_id).all()
        if group:
            surgeon_ids = list({g.id for g in group})
            aggregated = len(surgeon_ids) > 1
            surgeon_group = [ {'id': g.id, 'name': g.name, 'type': g.type} for g in group ]
    base = Video.query.filter(Video.surgeons.any(Surgeon.id.in_(surgeon_ids)))
    if q:
        base = base.filter(Video.title.ilike(f'%{q}%'))
    total = base.count()
    order_col = Video.created_at.desc() if sort_dir == 'desc' else Video.created_at.asc()
    videos = base.order_by(order_col).offset((page-1)*page_size).limit(page_size).all()
    items = [
        {
            'uuid': v.uuid,
            'title': v.title,
            'created_at': v.created_at.isoformat() if v.created_at else None,
            'views': v.views,
            'status': v.status.value if hasattr(v.status, 'value') else str(v.status),
            'surgeons': len(v.surgeons)
        } for v in videos
    ]
    subject = {'type': 'surgeon', 'id': s.id, 'name': s.name}
    if aggregated:
        subject['aggregated'] = True
        subject['surgeon_group'] = surgeon_group
    out = build_page_dict(items, page, page_size, total)
    out['subject'] = subject
    return jsonify(out)

@admin_api_bp.get('/users/<uid>/videos')
@jwt_required()
def user_videos(uid):
    u = db.session.get(User, coerce_uuid(uid))
    if not u:
        return jsonify({'msg': 'not found'}), 404
    q = (request.args.get('q') or '').strip().lower()
    page, page_size = parse_pagination_params()
    sort_dir = (request.args.get('sort_dir') or 'desc').lower()
    base = Video.query.filter(Video.user_id == u.id)
    if q:
        base = base.filter(Video.title.ilike(f'%{q}%'))
    total = base.count()
    order_col = Video.created_at.desc() if sort_dir == 'desc' else Video.created_at.asc()
    videos = base.order_by(order_col).offset((page-1)*page_size).limit(page_size).all()
    items = [
        {
            'uuid': v.uuid,
            'title': v.title,
            'created_at': v.created_at.isoformat() if v.created_at else None,
            'views': v.views,
            'status': v.status.value if hasattr(v.status, 'value') else str(v.status),
            'surgeons': len(v.surgeons)
        } for v in videos
    ]
    out = build_page_dict(items, page, page_size, total)
    out['subject'] = {'type': 'user', 'id': str(u.id), 'username': u.username}
    return jsonify(out)

@admin_api_bp.get('/dashboard/metrics')
@jwt_required()
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def admin_dashboard_metrics():
    # Optional bypass
    if request.args.get('nocache') == '1':
        metrics_cache.invalidate()
    cached = metrics_cache.get()
    if cached is not None:
        return jsonify(cached)
    metrics = _collect_admin_metrics()
    metrics_cache.set(metrics)
    return jsonify(metrics)

# Helper
def _collect_admin_metrics():
    now = datetime.now(timezone.utc)
    seven_days = now - timedelta(days=7)
    thirty_days = now - timedelta(days=30)
    ninety_days = now - timedelta(days=90)

    total_users = db.session.query(func.count(User.id)).scalar() or 0
    active_users = db.session.query(func.count(User.id)).filter(User.is_active.is_(True)).scalar() or 0
    verified_users = db.session.query(func.count(User.id)).filter(User.is_verified.is_(True)).scalar() or 0
    email_verified_users = db.session.query(func.count(User.id)).filter(User.is_email_verified.is_(True)).scalar() or 0
    locked_users = db.session.query(func.count(User.id)).filter(User.lock_until.isnot(None), User.lock_until > now).scalar() or 0
    users_last_7 = db.session.query(func.count(User.id)).filter(User.created_at >= seven_days).scalar() or 0
    users_last_30 = db.session.query(func.count(User.id)).filter(User.created_at >= thirty_days).scalar() or 0

    role_rows = db.session.query(UserRole.role, func.count(UserRole.user_id)).group_by(UserRole.role).all()
    roles = {r.value: 0 for r in Role}
    for role, cnt in role_rows:
        roles[getattr(role, 'value', str(role))] = cnt

    total_surgeons = db.session.query(func.count(Surgeon.id)).scalar() or 0
    linked_surgeons = db.session.query(func.count(Surgeon.id)).filter(Surgeon.user_id.isnot(None)).scalar() or 0
    unlinked_surgeons = total_surgeons - linked_surgeons

    total_videos = db.session.query(func.count(Video.uuid)).scalar() or 0
    video_status_rows = db.session.query(Video.status, func.count(Video.uuid)).group_by(Video.status).all()
    status_counts = {}
    for status, cnt in video_status_rows:
        key = getattr(status, 'value', str(status))
        status_counts[key] = cnt
    videos_last_7 = db.session.query(func.count(Video.uuid)).filter(Video.created_at >= seven_days).scalar() or 0
    videos_last_30 = db.session.query(func.count(Video.uuid)).filter(Video.created_at >= thirty_days).scalar() or 0
    total_views = db.session.query(func.coalesce(func.sum(Video.views), 0)).scalar() or 0
    avg_views = (total_views / total_videos) if total_videos else 0
    avg_duration = db.session.query(func.coalesce(func.avg(Video.duration), 0)).scalar() or 0

    total_favourites = db.session.query(func.count(Favourite.video_id)).scalar() or 0
    top_favourited = db.session.query(Favourite.video_id, func.count(Favourite.user_id).label('cnt')) \
        .group_by(Favourite.video_id).order_by(func.count(Favourite.user_id).desc()).limit(5).all()
    fav_video_map = {}
    if top_favourited:
        vids = [vid for vid, _ in top_favourited]
        for v in Video.query.filter(Video.uuid.in_(vids)).all():
            fav_video_map[v.uuid] = v.title
    top_favourited_list = [
        {'video_id': vid, 'title': fav_video_map.get(vid, ''), 'favourites': cnt}
        for vid, cnt in top_favourited
    ]

    top_viewed = Video.query.order_by(Video.views.desc()).limit(5).all()
    top_viewed_list = [ {'uuid': v.uuid, 'title': v.title, 'views': v.views} for v in top_viewed ]

    recent_videos = Video.query.order_by(Video.created_at.desc()).limit(5).all()
    recent_videos_list = [ {'uuid': v.uuid, 'title': v.title, 'created_at': v.created_at.isoformat() if v.created_at else None} for v in recent_videos ]
    recent_users = User.query.order_by(User.created_at.desc()).limit(5).all()
    recent_users_list = [ {'id': str(u.id), 'username': u.username, 'email': u.email, 'created_at': u.created_at.isoformat() if u.created_at else None} for u in recent_users ]

    surgeon_video_rows = db.session.query(Surgeon.id, Surgeon.name, func.count(VideoSurgeon.video_id).label('vc')) \
        .join(VideoSurgeon, Surgeon.id == VideoSurgeon.surgeon_id) \
        .group_by(Surgeon.id, Surgeon.name) \
        .order_by(func.count(VideoSurgeon.video_id).desc()) \
        .limit(5).all()
    top_surgeons = [ {'id': sid, 'name': name, 'videos': vc} for sid, name, vc in surgeon_video_rows ]

    active_tokens = db.session.query(func.count(Token.id)). \
        filter(Token.token_type == 'refresh', Token.revoked.is_(False), Token.expires_at > now).scalar() or 0

    # Build 90-day daily cumulative series from raw tables (no snapshot dependency)
    series_90d = []
    series_14d = []
    try:
        start_date = (now - timedelta(days=90)).date()
        # Baselines prior to window
        views_base = db.session.query(func.count(VideoViewEvent.id)).filter(VideoViewEvent.created_at < start_date).scalar() or 0
        videos_base = db.session.query(func.count(Video.uuid)).filter(Video.created_at < start_date).scalar() or 0
        users_base = db.session.query(func.count(User.id)).filter(User.created_at < start_date).scalar() or 0

        # Daily counts within window
        views_rows = db.session.query(func.date(VideoViewEvent.created_at), func.count(VideoViewEvent.id)). \
            filter(VideoViewEvent.created_at >= start_date).group_by(func.date(VideoViewEvent.created_at)).all()
        videos_rows = db.session.query(func.date(Video.created_at), func.count(Video.uuid)). \
            filter(Video.created_at >= start_date).group_by(func.date(Video.created_at)).all()
        users_rows = db.session.query(func.date(User.created_at), func.count(User.id)). \
            filter(User.created_at >= start_date).group_by(func.date(User.created_at)).all()

        views_map = {d: c for d, c in views_rows}
        videos_map = {d: c for d, c in videos_rows}
        users_map = {d: c for d, c in users_rows}

        cum_views = int(views_base)
        cum_videos = int(videos_base)
        cum_users = int(users_base)

        day = start_date
        prev_views = None
        for i in range(91):  # inclusive of today
            dv = int(views_map.get(day, 0))
            vv = int(videos_map.get(day, 0))
            uv = int(users_map.get(day, 0))
            cum_views += dv
            cum_videos += vv
            cum_users += uv
            delta = None if prev_views is None else dv
            prev_views = cum_views
            series_90d.append({
                'day': day.isoformat(),
                'total_views': cum_views,
                'total_videos': cum_videos,
                'total_users': cum_users,
                'views_delta': delta
            })
            day = day + timedelta(days=1)
        series_14d = series_90d[-14:]
    except Exception as e:
        current_app.logger.exception('series_build_failed', exc_info=True)

    return {
        'generated_at': now.isoformat(),
        'users': {
            'total': total_users,
            'active': active_users,
            'verified': verified_users,
            'email_verified': email_verified_users,
            'locked': locked_users,
            'last_7_days': users_last_7,
            'last_30_days': users_last_30,
            'roles': roles,
            'recent': recent_users_list
        },
        'surgeons': {
            'total': total_surgeons,
            'linked': linked_surgeons,
            'unlinked': unlinked_surgeons,
            'top_by_videos': top_surgeons
        },
        'videos': {
            'total': total_videos,
            'status_counts': status_counts,
            'last_7_days': videos_last_7,
            'last_30_days': videos_last_30,
            'total_views': int(total_views),
            'avg_views': round(avg_views, 2),
            'avg_duration': round(float(avg_duration or 0), 2),
            'top_viewed': top_viewed_list,
            'recent': recent_videos_list,
            'top_favourited': top_favourited_list,
            'series_14d': series_14d,
            'series_90d': series_90d
        },
        'favourites': {
            'total': total_favourites
        },
        'security': {
            'active_refresh_tokens': active_tokens,
            'locked_users': locked_users
        }
    }
