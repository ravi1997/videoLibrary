from app.routes.v1.auth_route import auth_bp
from flask import Blueprint
from app.models import User, Surgeon, Video, VideoSurgeon, RefreshToken, DashboardDailySnapshot
from app.models.User import UserRole
from app.models.video import Favourite
from sqlalchemy import func, inspect
from datetime import datetime, timedelta, timezone
from app.extensions import db
from flask_jwt_extended import jwt_required
from app.utils.decorator import require_roles
from app.models.enumerations import Role
from flask import request, jsonify, render_template, current_app
from app.routes.v1.view_route import view_bp
from app.routes.v1.user_route import user_bp
from app.routes.v1.video_route import video_bp

def register_blueprints(app):
    app.register_blueprint(view_bp, url_prefix='/')

    app.register_blueprint(user_bp, url_prefix='/api/v1/user')
    app.register_blueprint(auth_bp, url_prefix='/api/v1/auth')

    # Admin surgeon linking blueprint (simple)
    admin_link_bp = Blueprint('admin_link_bp', __name__)

    @admin_link_bp.get('/admin/link-surgeons')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def link_surgeons_page():
        return render_template('link_surgeons.html')

    @admin_link_bp.get('/api/v1/admin/surgeons')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def list_surgeons():
        q = (request.args.get('q') or '').strip().lower()
        page = max(1, int(request.args.get('page', 1) or 1))
        page_size = min(100, max(1, int(request.args.get('page_size', 20) or 20)))
        link_filter = (request.args.get('linked') or '').lower()  # '', 'yes', 'no'
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
        pages = max(1, (total + page_size - 1)//page_size)
        return jsonify({'items': out, 'page': page, 'pages': pages, 'total': total, 'counts': {'linked': linked_count, 'unlinked': unlinked_count}})

    @admin_link_bp.get('/api/v1/admin/users')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def list_users_for_link():
        q = (request.args.get('q') or '').strip().lower()
        page = max(1, int(request.args.get('page', 1) or 1))
        page_size = min(100, max(1, int(request.args.get('page_size', 20) or 20)))
        link_filter = (request.args.get('has_surgeon') or '').lower()  # '', 'yes','no'
        sort_by = (request.args.get('sort_by') or 'created_at').lower()
        sort_dir = (request.args.get('sort_dir') or 'desc').lower()

        base_q = User.query
        if q:
            base_q = base_q.filter(User.username.ilike(f'%{q}%'))

        # counts relative to current search
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
        pages = max(1, (total + page_size - 1)//page_size)

        out = []
        for u in users:
            out.append({
                'id': str(u.id),
                'username': u.username,
                'email': u.email,
                'has_surgeon': bool(u.surgeon)
            })
        return jsonify({'items': out, 'page': page, 'pages': pages, 'total': total, 'counts': {'with': with_count, 'without': without_count}})

    @admin_link_bp.post('/api/v1/admin/surgeons')
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
        return jsonify({'msg': 'created', 'id': s.id}), 201

    @admin_link_bp.post('/api/v1/admin/surgeons/bulk/link')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def bulk_link_surgeons():
        data = request.get_json(force=True) or {}
        surgeon_ids = data.get('surgeon_ids') or []
        user_id = (data.get('user_id') or '').strip()
        if not surgeon_ids or not user_id:
            return jsonify({'msg': 'surgeon_ids and user_id required'}), 400
        user = User.query.get(user_id)
        if not user:
            return jsonify({'msg': 'user not found'}), 404
        updated = 0
        for sid in surgeon_ids:
            s = Surgeon.query.get(sid)
            if s:
                s.user_id = user.id
                updated += 1
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({'msg': 'bulk persist failed'}), 500
        return jsonify({'msg': 'bulk linked', 'count': updated, 'user_id': str(user.id)})

    @admin_link_bp.post('/api/v1/admin/surgeons/bulk/unlink')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def bulk_unlink_surgeons():
        data = request.get_json(force=True) or {}
        surgeon_ids = data.get('surgeon_ids') or []
        if not surgeon_ids:
            return jsonify({'msg': 'surgeon_ids required'}), 400
        updated = 0
        for sid in surgeon_ids:
            s = Surgeon.query.get(sid)
            if s and s.user_id is not None:
                s.user_id = None
                updated += 1
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({'msg': 'bulk persist failed'}), 500
        return jsonify({'msg': 'bulk unlinked', 'count': updated})

    @admin_link_bp.post('/api/v1/admin/surgeons/<int:sid>/link')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def link_surgeon_user(sid):
        data = request.get_json(force=True)
        user_id = (data.get('user_id') or '').strip()
        if not user_id:
            return jsonify({'msg': 'user_id required'}), 400
        surgeon = Surgeon.query.get(sid)
        if not surgeon:
            return jsonify({'msg': 'surgeon not found'}), 404
        user = User.query.get(user_id)
        if not user:
            return jsonify({'msg': 'user not found'}), 404
        surgeon.user_id = user.id
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({'msg': 'persist failed'}), 500
        return jsonify({'msg': 'linked', 'surgeon_id': surgeon.id, 'user_id': str(user.id)})

    @admin_link_bp.post('/api/v1/admin/surgeons/<int:sid>/unlink')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def unlink_surgeon_user(sid):
        surgeon = Surgeon.query.get(sid)
        if not surgeon:
            return jsonify({'msg': 'surgeon not found'}), 404
        surgeon.user_id = None
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({'msg': 'persist failed'}), 500
        return jsonify({'msg': 'unlinked', 'surgeon_id': surgeon.id})

    @admin_link_bp.get('/api/v1/admin/surgeons/<int:sid>/detail')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def surgeon_detail(sid):
        s = Surgeon.query.get(sid)
        if not s:
            return jsonify({'msg': 'not found'}), 404
        user = None
        if s.user_id:
            u = User.query.get(s.user_id)
            if u:
                user = {'id': str(u.id), 'username': u.username, 'email': u.email}
        return jsonify({
            'id': s.id,
            'name': s.name,
            'type': s.type,
            'description': s.description or '',
            'user': user
        })

    @admin_link_bp.get('/api/v1/admin/users/<uid>/surgeons')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def user_surgeons(uid):
        u = User.query.get(uid)
        if not u:
            return jsonify({'msg': 'not found'}), 404
        # assuming one-to-one currently, but spec wants all surgeons linked to user; query by user_id
        surgeons = Surgeon.query.filter(Surgeon.user_id == u.id).all()
        return jsonify({
            'user_id': str(u.id),
            'surgeons': [ {'id': s.id, 'name': s.name, 'type': s.type} for s in surgeons ]
        })

    # ---------- Linked Videos Page & APIs ----------
    @admin_link_bp.get('/admin/linked-videos')
    @jwt_required()
    def linked_videos_page():
        # expects surgeon_id or user_id in query; template JS will refetch
        surgeon_id = request.args.get('surgeon_id')
        user_id = request.args.get('user_id')
        return render_template('linked_videos.html', surgeon_id=surgeon_id, user_id=user_id)

    @admin_link_bp.get('/api/v1/admin/surgeons/<int:sid>/videos')
    @jwt_required()
    def surgeon_videos(sid):
        s = Surgeon.query.get(sid)
        if not s:
            return jsonify({'msg': 'not found'}), 404
        q = (request.args.get('q') or '').strip().lower()
        page = max(1, int(request.args.get('page', 1) or 1))
        page_size = min(100, max(1, int(request.args.get('page_size', 20) or 20)))
        sort_dir = (request.args.get('sort_dir') or 'desc').lower()
        # If surgeon linked to a user, aggregate videos across all surgeons linked to that user
        surgeon_ids = [s.id]
        aggregated = False
        surgeon_group = []
        if s.user_id:
            group = Surgeon.query.filter(Surgeon.user_id == s.user_id).all()
            if group:
                surgeon_ids = list({g.id for g in group})  # distinct
                aggregated = len(surgeon_ids) > 1
                surgeon_group = [ {'id': g.id, 'name': g.name, 'type': g.type} for g in group ]
        # Use .any() relationship filter to avoid duplicate rows without needing DISTINCT ON
        base = Video.query.filter(Video.surgeons.any(Surgeon.id.in_(surgeon_ids)))
        if q:
            base = base.filter(Video.title.ilike(f'%{q}%'))
        total = base.count()
        order_col = Video.created_at.desc() if sort_dir == 'desc' else Video.created_at.asc()
        videos = base.order_by(order_col).offset((page-1)*page_size).limit(page_size).all()
        pages = max(1, (total + page_size - 1)//page_size)
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
        return jsonify({'items': items, 'page': page, 'pages': pages, 'total': total, 'subject': subject})

    @admin_link_bp.get('/api/v1/admin/users/<uid>/videos')
    @jwt_required()
    def user_videos(uid):
        u = User.query.get(uid)
        if not u:
            return jsonify({'msg': 'not found'}), 404
        q = (request.args.get('q') or '').strip().lower()
        page = max(1, int(request.args.get('page', 1) or 1))
        page_size = min(100, max(1, int(request.args.get('page_size', 20) or 20)))
        sort_dir = (request.args.get('sort_dir') or 'desc').lower()
        base = Video.query.filter(Video.user_id == u.id)
        if q:
            base = base.filter(Video.title.ilike(f'%{q}%'))
        total = base.count()
        order_col = Video.created_at.desc() if sort_dir == 'desc' else Video.created_at.asc()
        videos = base.order_by(order_col).offset((page-1)*page_size).limit(page_size).all()
        pages = max(1, (total + page_size - 1)//page_size)
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
        return jsonify({'items': items, 'page': page, 'pages': pages, 'total': total, 'subject': {'type': 'user', 'id': str(u.id), 'username': u.username}})

    # ---------------------- Admin Dashboard ----------------------
    @admin_link_bp.get('/admin/dashboard')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def admin_dashboard_page():
        metrics = _collect_admin_metrics()
        return render_template('admin_dashboard.html', metrics=metrics)

    @admin_link_bp.get('/api/v1/admin/dashboard/metrics')
    @jwt_required()
    @require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
    def admin_dashboard_metrics():
        metrics = _collect_admin_metrics()
        return jsonify(metrics)

    # Helper to gather metrics
    def _collect_admin_metrics():
        now = datetime.now(timezone.utc)
        seven_days = now - timedelta(days=7)
        thirty_days = now - timedelta(days=30)
        fourteen_days = now - timedelta(days=14)
        ninety_days = now - timedelta(days=90)

        # Users
        total_users = db.session.query(func.count(User.id)).scalar() or 0
        active_users = db.session.query(func.count(User.id)).filter(User.is_active.is_(True)).scalar() or 0
        verified_users = db.session.query(func.count(User.id)).filter(User.is_verified.is_(True)).scalar() or 0
        email_verified_users = db.session.query(func.count(User.id)).filter(User.is_email_verified.is_(True)).scalar() or 0
        locked_users = db.session.query(func.count(User.id)).filter(User.lock_until.isnot(None), User.lock_until > now).scalar() or 0
        users_last_7 = db.session.query(func.count(User.id)).filter(User.created_at >= seven_days).scalar() or 0
        users_last_30 = db.session.query(func.count(User.id)).filter(User.created_at >= thirty_days).scalar() or 0

        # Role distribution
        role_rows = db.session.query(UserRole.role, func.count(UserRole.user_id)).group_by(UserRole.role).all()
        roles = {r.value: 0 for r in Role}
        for role, cnt in role_rows:
            roles[getattr(role, 'value', str(role))] = cnt

        # Surgeons
        total_surgeons = db.session.query(func.count(Surgeon.id)).scalar() or 0
        linked_surgeons = db.session.query(func.count(Surgeon.id)).filter(Surgeon.user_id.isnot(None)).scalar() or 0
        unlinked_surgeons = total_surgeons - linked_surgeons

        # Videos
        total_videos = db.session.query(func.count(Video.uuid)).scalar() or 0
        video_status_rows = db.session.query(Video.status, func.count(Video.uuid)).group_by(Video.status).all()
        status_counts = {s.value: 0 for s in []}
        # dynamic mapping
        status_counts = {}
        for status, cnt in video_status_rows:
            key = getattr(status, 'value', str(status))
            status_counts[key] = cnt
        videos_last_7 = db.session.query(func.count(Video.uuid)).filter(Video.created_at >= seven_days).scalar() or 0
        videos_last_30 = db.session.query(func.count(Video.uuid)).filter(Video.created_at >= thirty_days).scalar() or 0
        total_views = db.session.query(func.coalesce(func.sum(Video.views), 0)).scalar() or 0
        avg_views = (total_views / total_videos) if total_videos else 0
        avg_duration = db.session.query(func.coalesce(func.avg(Video.duration), 0)).scalar() or 0

        # Favourites
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

        # Top viewed videos
        top_viewed = Video.query.order_by(Video.views.desc()).limit(5).all()
        top_viewed_list = [ {'uuid': v.uuid, 'title': v.title, 'views': v.views} for v in top_viewed ]

        # Recent videos & users
        recent_videos = Video.query.order_by(Video.created_at.desc()).limit(5).all()
        recent_videos_list = [ {'uuid': v.uuid, 'title': v.title, 'created_at': v.created_at.isoformat() if v.created_at else None} for v in recent_videos ]
        recent_users = User.query.order_by(User.created_at.desc()).limit(5).all()
        recent_users_list = [ {'id': str(u.id), 'username': u.username, 'email': u.email, 'created_at': u.created_at.isoformat() if u.created_at else None} for u in recent_users ]

        # Surgeons by video count
        surgeon_video_rows = db.session.query(Surgeon.id, Surgeon.name, func.count(VideoSurgeon.video_id).label('vc')) \
            .join(VideoSurgeon, Surgeon.id == VideoSurgeon.surgeon_id) \
            .group_by(Surgeon.id, Surgeon.name) \
            .order_by(func.count(VideoSurgeon.video_id).desc()) \
            .limit(5).all()
        top_surgeons = [ {'id': sid, 'name': name, 'videos': vc} for sid, name, vc in surgeon_video_rows ]

        # Active refresh tokens
        active_tokens = db.session.query(func.count(RefreshToken.id)).filter(RefreshToken.revoked.is_(False), RefreshToken.expires_at > now).scalar() or 0

        # -------- Time Series (14d / 90d daily cumulative snapshots) --------
        series_90d = []
        series_14d = []
        try:
            try:
                DashboardDailySnapshot.upsert_today(int(total_views), int(total_videos), int(total_users))
            except Exception as e:
                current_app.logger.warning(f"Dashboard snapshot upsert failed: {e}")
                db.session.rollback()
                try:
                    engine = db.engine
                    insp = inspect(engine)
                    if 'dashboard_daily_snapshots' not in insp.get_table_names():
                        DashboardDailySnapshot.__table__.create(bind=engine)
                        current_app.logger.info("Runtime-created dashboard_daily_snapshots table (apply Alembic migration to persist).")
                        DashboardDailySnapshot.upsert_today(int(total_views), int(total_videos), int(total_users))
                except Exception as ce:
                    current_app.logger.warning(f"Runtime creation of dashboard_daily_snapshots failed: {ce}")
            # Fetch up to 90 days for front-end range switching
            try:
                all_rows = DashboardDailySnapshot.query.filter(
                    DashboardDailySnapshot.day >= ninety_days.date()
                ).order_by(DashboardDailySnapshot.day.asc()).all()
            except Exception as e:
                current_app.logger.warning(f"Dashboard snapshot fetch failed: {e}")
                db.session.rollback()
                all_rows = []
            prev_views = None
            for r in all_rows:
                delta = None
                if prev_views is not None:
                    delta = (r.total_views - prev_views)
                prev_views = r.total_views
                rec = {
                    'day': r.day.isoformat(),
                    'total_views': int(r.total_views),
                    'total_videos': int(r.total_videos),
                    'total_users': int(r.total_users),
                    'views_delta': int(delta) if delta is not None else None
                }
                series_90d.append(rec)
            # 14 day slice from tail
            series_14d = series_90d[-14:]
        except Exception as e:
            current_app.logger.exception(f"Unexpected error assembling time series: {e}")
            db.session.rollback()
        # If less than 14 entries, pad earlier days with nulls for consistent chart axis
        # (front-end can handle variable length, but stable length simplifies rendering)
        # We won't fabricate historical values; just allow shorter series.

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

    app.register_blueprint(admin_link_bp)
    app.register_blueprint(video_bp, url_prefix='/api/v1/video')
    app.logger.info("Blueprints registered: auth_routes, user_routes, video_routes")