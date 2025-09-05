import pytest
from flask_jwt_extended import create_access_token
from app import create_app, Config
from app.extensions import db
from app.models.User import User, UserRole, Role

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
def superadmin(app_ctx):
    u = User(username='boss', email='boss@example.com')
    u.set_password('Str0ng!Pass1')
    u.is_verified = True
    u.role_associations.append(UserRole(role=Role.SUPERADMIN))
    db.session.add(u)
    db.session.commit()
    return u

@pytest.fixture()
def super_header(superadmin):
    token = create_access_token(identity=str(superadmin.id), additional_claims={'roles':[r.value for r in superadmin.roles]})
    return {'Authorization': f'Bearer {token}'}

def test_super_users_requires_auth(client):
    r = client.get('/api/v1/super/users')
    assert r.status_code in (401, 422)  # missing token


def test_super_users_list_ok(client, super_header):
    r = client.get('/api/v1/super/users', headers=super_header)
    assert r.status_code == 200
    body = r.get_json()
    assert 'items' in body
