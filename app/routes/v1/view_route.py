from urllib.parse import unquote
from datetime import datetime
from flask import Blueprint, current_app, render_template, request, jsonify
from app.config import Config
from app.models.User import User
from app.models.TokenBlocklist import TokenBlocklist
from app.models.video import Video
from app.schemas.user_schema import UserSchema
from flask_jwt_extended import (
    create_access_token, jwt_required,
    get_jwt, set_access_cookies, unset_jwt_cookies
)
from app.utils.decorator import require_roles
from mongoengine import DoesNotExist
view_bp = Blueprint('view_bp', __name__)



@view_bp.route('/<video_id>')
def video(video_id):
    return render_template('video.html', video_id=video_id)


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
def category_page(category_name):
    category_name = unquote(category_name)
    return render_template('category.html', category=category_name)

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
def admin_unverified_page(user_id):  # injected by decorator
    return render_template('admin_unverified.html')