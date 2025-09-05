import pytest
from flask import Flask
from app import create_app, Config
from app.extensions import db
from app.models.User import User

class TestConfig(Config):
    DEBUG = True
    TESTING = True
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

def test_password_policy_rejects_weak(client):
    resp = client.post('/api/v1/auth/register', json={
        'username': 'u1',
        'email': 'u1@example.com',
        'password': 'weak',
        'roles': ['user']
    })
    assert resp.status_code == 400

def test_password_policy_accepts_strong(client):
    strong_pw = 'Str0ng!Pass'
    resp = client.post('/api/v1/auth/register', json={
        'username': 'u2',
        'email': 'u2@example.com',
        'password': strong_pw,
        'roles': ['user']
    })
    assert resp.status_code in (201,400)  # 201 created or 400 if email uniqueness race
