from urllib.parse import unquote
from datetime import datetime
from flask import Blueprint, current_app, render_template, request, jsonify, abort
from app.config import Config
from app.models.User import User
from app.models.TokenBlocklist import TokenBlocklist
from app.models.video import Video, Category
from app.schemas.user_schema import UserSchema
from flask_jwt_extended import (
    create_access_token, jwt_required,
    get_jwt, set_access_cookies, unset_jwt_cookies
)
from app.utils.decorator import require_roles
from mongoengine import DoesNotExist
view_bp = Blueprint('view_bp', __name__)



@view_bp.route('/<video_id>')
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
    videos = Video.query.order_by(Video.created_at.desc()).all()
    return render_template('index.html', videos=videos)


@view_bp.route('/search')
def search_page():
    q = request.args.get('q', '')
    return render_template('search.html', q=q)


@view_bp.route('/upload')
def upload_page():
    return render_template('upload.html')


@view_bp.route('/login')
def login_page():
    return render_template('login.html')

@view_bp.route('/category/<category_name>')
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

@view_bp.route('/favourites')
def favourites_page():
    return render_template('favourites.html')

@view_bp.route('/profile')
def profile_page():
    return render_template('profile.html')


@view_bp.route('/settings')
def settings_page():
    return render_template('settings.html')

@view_bp.route('/history')
def history_page():
    return render_template('history.html')

@view_bp.route('/change-password')
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
    return render_template('terms.html', effective_date=datetime.utcnow().date())

@view_bp.route('/privacy')
def privacy_page():
    return render_template('privacy.html', effective_date=datetime.utcnow().date())

@view_bp.route('/admin/unverified')
@jwt_required()
@require_roles('admin','superadmin')
def admin_unverified_page():  # injected by decorator
    return render_template('admin_unverified.html')