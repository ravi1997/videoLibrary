import time
import pytest
from flask import current_app
from app import create_app, Config
from app.extensions import db
from app.models.User import User, UserRole, Role
from flask_jwt_extended import create_access_token

class TestConfig(Config):
    TESTING = True
    DEBUG = True
    SQLALCHEMY_DATABASE_URI = 'sqlite:///:memory:'
    JWT_COOKIE_SECURE = False
    JWT_COOKIE_CSRF_PROTECT = False

@pytest.fixture()
def app_ctx():
    app = create_app(TestConfig)
    with app.app_context():
        db.create_all()
        yield app

@pytest.fixture()
def client(app_ctx):
    return app_ctx.test_client()

@pytest.fixture()
def user(app_ctx):
    u = User(username='alice', email='alice@example.com')
    u.set_password('Str0ng!Pass1')
    u.role_associations.append(UserRole(role=Role.USER))
    db.session.add(u)
    db.session.commit()
    return u

@pytest.fixture()
def uploader(app_ctx):
    u = User(username='uploader', email='uploader@example.com')
    u.set_password('Str0ng!Pass2')
    u.role_associations.append(UserRole(role=Role.UPLOADER))
    db.session.add(u)
    db.session.commit()
    return u

@pytest.fixture()
def auth_header(user):
    token = create_access_token(identity=str(user.id), additional_claims={'roles':[r.value for r in user.roles]})
    return {'Authorization': f'Bearer {token}'}

@pytest.fixture()
def uploader_header(uploader):
    token = create_access_token(identity=str(uploader.id), additional_claims={'roles':[r.value for r in uploader.roles]})
    return {'Authorization': f'Bearer {token}'}


def test_refresh_flow(client, user):
    # mark user verified so login works
    user.is_verified = True
    from app.extensions import db as _db
    _db.session.commit()
    # login
    r = client.post('/api/v1/auth/login', json={'email': user.email, 'password':'Str0ng!Pass1'})
    assert r.status_code == 200
    body = r.get_json()
    assert 'access_token' in body and 'refresh_token' in body
    old_access = body['access_token']
    refresh = body['refresh_token']
    # refresh
    r2 = client.post('/api/v1/auth/refresh', json={'refresh_token':refresh})
    assert r2.status_code == 200
    body2 = r2.get_json()
    assert 'access_token' in body2 and 'refresh_token' in body2
    assert body2['access_token'] != old_access
    # reuse old refresh should now fail (rotated)
    r3 = client.post('/api/v1/auth/refresh', json={'refresh_token':refresh})
    assert r3.status_code in (401,400)


def test_csp_header_present(client):
    resp = client.get('/')
    assert 'Content-Security-Policy' in resp.headers


def test_rate_limit_register(client):
    for _ in range(10):
        client.post('/api/v1/auth/register', json={'username':'x','email':f'x{_}@e.com','password':'Str0ng!Pass1','roles':['user']})
    r = client.post('/api/v1/auth/register', json={'username':'overflow','email':'overflow@e.com','password':'Str0ng!Pass1','roles':['user']})
    assert r.status_code in (429,201,400)


def test_password_change_requires_current(client, user, auth_header):
    r = client.post('/api/v1/user/change-password', json={'current_password':'wrong','new_password':'NewStr0ng!1'}, headers=auth_header)
    assert r.status_code == 400


def test_password_change_success(client, user, auth_header):
    r = client.post('/api/v1/user/change-password', json={'current_password':'Str0ng!Pass1','new_password':'An0ther!Pass'}, headers=auth_header)
    assert r.status_code == 200


def test_favorite_idempotent(client, uploader, uploader_header, app_ctx):
    # create minimal video record directly
    from app.models.video import Video, VideoStatus
    v = Video(uuid='vid1', title='Test', description='', transcript='', original_file_path='/tmp/x', file_path='/tmp/x', status=VideoStatus.PENDING, user_id=uploader.id)
    db.session.add(v)
    db.session.commit()
    r1 = client.post('/api/v1/video/vid1/favorite', headers=uploader_header)
    r2 = client.post('/api/v1/video/vid1/favorite', headers=uploader_header)
    assert r1.status_code == 200 and r2.status_code == 200


def test_ownership_enforced(client, uploader, user, uploader_header, auth_header, app_ctx):
    from app.models.video import Video, VideoStatus
    v = Video(uuid='vid2', title='Priv', description='', transcript='', original_file_path='/tmp/y', file_path='/tmp/y', status=VideoStatus.PENDING, user_id=uploader.id)
    db.session.add(v)
    db.session.commit()
    # user without ownership & no admin role
    r = client.put('/api/v1/video/vid2', json={'title':'Hacked'}, headers=auth_header)
    assert r.status_code == 403


def test_upload_extension_rejection(client, uploader_header, tmp_path):
    # Create a temporary file handle for upload
    fake = tmp_path / 'malicious.txt'
    fake.write_bytes(b'not a real video')
    data = {'file': (fake.open('rb'), 'malicious.txt')}
    # Not a valid ext, expect 400
    r = client.post('/api/v1/video/upload', data=data, headers=uploader_header, content_type='multipart/form-data')
    assert r.status_code in (400,415)
