import os
from dotenv import load_dotenv

# Load environment variables from a .env file if it exists
load_dotenv()
print("Loaded SECRET_KEY:", os.getenv("DATABASE_URI"))

class Config:
    DEBUG = True
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
    JWT_COOKIE_SECURE = False
    JWT_COOKIE_CSRF_PROTECT = False
    JWT_TOKEN_LOCATION = ["headers", "cookies"]

    # Roles
    ADMIN_ROLE = "admin"
    USER_ROLE = "user"


    SMS_API_URL=os.getenv("SMS_API_URL","")
    SMS_SENDER_ID=os.getenv("SMS_SENDER_ID","")
    SMS_TEMPLATE_ID=os.getenv("SMS_TEMPLATE_ID","")
    SMS_API_USERNAME=os.getenv("SMS_API_USERNAME","")
    SMS_API_PASSWORD=os.getenv("SMS_API_PASSWORD","")


    EHOSPITAL_INIT_URL=os.getenv("EHOSPITAL_INIT_URL","")
    EHOSPITAL_FETCH_PATIENT_URL=os.getenv("EHOSPITAL_FETCH_PATIENT_URL","")
    EHOSPITAL_USERNAME=os.getenv("EHOSPITAL_USERNAME","")
    EHOSPITAL_PASSWORD=os.getenv("EHOSPITAL_PASSWORD","")
    EHOSPITAL_HOSPITAL_ID=os.getenv("EHOSPITAL_HOSPITAL_ID",0)


class DevelopmentConfig(Config):
    SQLALCHEMY_DATABASE_URI = os.getenv("DEVELOPMENT_DATABASE_URI", "sqlite:///dev.db")
    MY_ENVIRONMENT = "DEVELOPMENT"
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
