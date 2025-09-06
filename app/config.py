import os
from dotenv import load_dotenv

# Load environment variables from a .env file if it exists
load_dotenv()
# SECURITY: avoid printing secrets / connection strings in stdout


class Config:
    # Default to False; individual env config classes can override
    DEBUG = False
    MY_ENVIRONMENT = "PRODUCTION"
    SECRET_KEY = os.getenv("SECRET_KEY", "your_secret_key")
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URI", "sqlite:///app.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "your_jwt_secret")

    # MongoDB (default fallback)
    MONGODB_SETTINGS = {
        'db': os.getenv("MONGODB_DB", "myflaskdb"),
        'host': os.getenv("MONGODB_HOST", "localhost"),
        'port': int(os.getenv("MONGODB_PORT", 27017)),
        'username': os.getenv("MONGODB_USER", None),
        'password': os.getenv("MONGODB_PASS", None),
        'auth_source': os.getenv("MONGODB_AUTH_SOURCE", "admin"),
    }

    # Admin user config
    ADMIN_USERNAME = os.getenv("DEVELOPMENT_ADMIN_USERNAME", "admin")
    ADMIN_EMAIL = os.getenv("DEVELOPMENT_ADMIN_EMAIL", "admin@example.com")
    ADMIN_PASSWORD = os.getenv("DEVELOPMENT_ADMIN_PASSWORD", "admin123")

    # Default user config
    USER_USERNAME = os.getenv("DEVELOPMENT_USER_USERNAME", "user")
    USER_EMAIL = os.getenv("DEVELOPMENT_USER_EMAIL", "user@example.com")
    USER_PASSWORD = os.getenv("DEVELOPMENT_USER_PASSWORD", "user123")

    # JWT settings
    JWT_BLACKLIST_ENABLED = True
    JWT_BLACKLIST_TOKEN_CHECKS = ["access"]
    JWT_ACCESS_COOKIE_NAME = "access_token_cookie"
    # Harden cookie defaults (can be relaxed for local dev)
    JWT_COOKIE_SECURE = os.getenv("JWT_COOKIE_SECURE", "true").lower() == "true"
    JWT_COOKIE_CSRF_PROTECT = os.getenv("JWT_COOKIE_CSRF_PROTECT", "true").lower() == "true"
    JWT_TOKEN_LOCATION = ["headers", "cookies"]
    # Lifetimes (can be overridden by env). Access short-lived; refresh long-lived
    from datetime import timedelta
    # Access token lifetime (increase default from 15 -> 60 minutes). Override via JWT_ACCESS_TOKEN_MINUTES env.
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=int(os.getenv("JWT_ACCESS_TOKEN_MINUTES", "60")))
    REFRESH_TOKEN_EXPIRES_MINUTES = int(os.getenv("REFRESH_TOKEN_EXPIRES_MINUTES", "43200"))  # 30 days default

    # Superadmin bootstrap (optional). If set and no superadmin exists, one will be created at startup.
    SUPERADMIN_USERNAME = os.environ.get('SUPERADMIN_USERNAME') or 'superadmin'
    SUPERADMIN_EMAIL = os.environ.get('SUPERADMIN_EMAIL') or 'superadmin@example.com'
    SUPERADMIN_EMPLOYEE_ID = os.environ.get('SUPERADMIN_EMPLOYEE_ID') or 'SUPER001'
    SUPERADMIN_MOBILE = os.environ.get('SUPERADMIN_MOBILE') or '9000000000'
    SUPERADMIN_PASSWORD = os.environ.get('SUPERADMIN_PASSWORD')  # Intentionally no default; if None bootstrap skips


    # Roles
    ADMIN_ROLE = "admin"
    USER_ROLE = "user"


    SMS_API_URL=os.getenv("SMS_API_URL","")
    SMS_API_TOKEN = os.getenv("SMS_API_TOKEN", "")


    EHOSPITAL_INIT_URL=os.getenv("EHOSPITAL_INIT_URL","")
    EHOSPITAL_FETCH_PATIENT_URL=os.getenv("EHOSPITAL_FETCH_PATIENT_URL","")
    EHOSPITAL_USERNAME=os.getenv("EHOSPITAL_USERNAME","")
    EHOSPITAL_PASSWORD=os.getenv("EHOSPITAL_PASSWORD","")
    EHOSPITAL_HOSPITAL_ID=os.getenv("EHOSPITAL_HOSPITAL_ID",0)

    CDAC_AUTH_BEARER = os.getenv("CDAC_AUTH_BEARER", "")
    CDAC_SERVER = os.getenv("CDAC_SERVER", "")

    UPLOAD_FOLDER = os.getenv("UPLOAD_FOLDER", "/app/uploads")
    # Public playback toggle (if true, exposes /api/v1/video/public/* endpoints without JWT)
    ALLOW_PUBLIC_PLAYBACK = os.getenv("ALLOW_PUBLIC_PLAYBACK", "false").lower() == "true"
    # Auto-run migrations at startup if set (safe for dev containers / CI). Accepts: true/1/yes
    AUTO_MIGRATE_ON_STARTUP = os.getenv("AUTO_MIGRATE_ON_STARTUP", "false").lower() in ("1", "true", "yes")

    # Upload hardening
    MAX_CONTENT_LENGTH_MB = int(os.getenv("MAX_CONTENT_LENGTH_MB", "600"))  # global cap
    MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH_MB * 1024 * 1024
    ID_UPLOAD_MAX_MB = int(os.getenv("ID_UPLOAD_MAX_MB", "10"))

class DevelopmentConfig(Config):
    DEBUG = True
    SQLALCHEMY_DATABASE_URI = os.getenv("DEVELOPMENT_DATABASE_URI", "sqlite:///dev.db")
    MY_ENVIRONMENT = "DEVELOPMENT"
    # Permit insecure cookies in dev for convenience
    JWT_COOKIE_SECURE = False
    JWT_COOKIE_CSRF_PROTECT = False
    MONGODB_SETTINGS = {
        'db': os.getenv("DEV_MONGODB_DB", "devdb"),
        'host': os.getenv("DEV_MONGODB_HOST", "localhost"),
        'port': int(os.getenv("DEV_MONGODB_PORT", 27017)),
    }


class TestingConfig(Config):
    TESTING = True
    MY_ENVIRONMENT = "TESTING"
    SQLALCHEMY_DATABASE_URI = os.getenv("TEST_DATABASE_URI", "sqlite:///test.db")
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "test-secret")

    MONGODB_SETTINGS = {
        'db': os.getenv("TEST_MONGODB_DB", "testdb"),
        'host': os.getenv("TEST_MONGODB_HOST", "localhost"),
        'port': int(os.getenv("TEST_MONGODB_PORT", 27017)),
    }

    ADMIN_USERNAME = os.getenv("TEST_ADMIN_USERNAME", "test_admin")
    ADMIN_EMAIL = os.getenv("TEST_ADMIN_EMAIL", "test_admin@example.com")
    ADMIN_PASSWORD = os.getenv("TEST_ADMIN_PASSWORD", "test123")

    USER_USERNAME = os.getenv("TEST_USER_USERNAME", "test_user")
    USER_EMAIL = os.getenv("TEST_USER_EMAIL", "test_user@example.com")
    USER_PASSWORD = os.getenv("TEST_USER_PASSWORD", "test123")


class ProductionConfig(Config):
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URI", "sqlite:///prod.db")
    MY_ENVIRONMENT = "PRODUCTION"
    MONGODB_SETTINGS = {
        'db': os.getenv("MONGODB_DB", "prodflaskdb"),
        'host': os.getenv("MONGODB_HOST", "localhost"),
        'port': int(os.getenv("MONGODB_PORT", 27017)),
        'username': os.getenv("MONGODB_USER", None),
        'password': os.getenv("MONGODB_PASS", None),
    }
