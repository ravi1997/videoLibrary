from flask import Flask, request, jsonify, send_from_directory
from app.security_utils import log_structured
import logging
from logging.handlers import RotatingFileHandler
import os
from flask_compress import Compress
from flask_cors import CORS

from app.tasks import start_hls_worker


from .commands.user_commands import create_user

from app.routes import register_blueprints

from .config import Config
from .extensions import mongo, jwt, db, migrate,ma
from .security import init_jwt_callbacks
from .models import *



def configure_logging(app):
    log_dir = "logs"
    os.makedirs(log_dir, exist_ok=True)

    if not app.logger.handlers:
        file_handler = RotatingFileHandler(
            os.path.join(log_dir, "app.log"),
            maxBytes=10240,
            backupCount=5
        )
        formatter = logging.Formatter(
            "[%(asctime)s] %(levelname)s in %(module)s: %(message)s"
        )
        file_handler.setFormatter(formatter)
        file_handler.setLevel(logging.DEBUG)
        app.logger.addHandler(file_handler)

    app.logger.setLevel(logging.DEBUG)
    app.logger.info("Logging configured.")


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    configure_logging(app)
    app.logger.info("Using config: %s", config_class.__name__)
    
    db.init_app(app)
    migrate.init_app(app, db)
    ma.init_app(app)
    jwt.init_app(app)
    init_jwt_callbacks(jwt)
    app.cli.add_command(create_user)

    # ------------------------------------------------------------------
    # Logging & Access log middleware
    # ------------------------------------------------------------------
    @app.before_request
    def _log_request():
        log_structured("request", method=request.method, path=request.path, ip=request.remote_addr, args=dict(request.args))

    @app.after_request
    def _log_response(resp):
        log_structured("response", method=request.method, path=request.path, status=resp.status_code)
        # Security headers (idempotent set / override)
        resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
        resp.headers.setdefault('X-Frame-Options', 'DENY')
        resp.headers.setdefault('X-XSS-Protection', '1; mode=block')
        resp.headers.setdefault('Referrer-Policy', 'no-referrer')
        resp.headers.setdefault('Permissions-Policy', 'fullscreen=()')
        # CSP tightened; allow blob for workers (Video.js HLS), allow media from self, permit data: images/fonts
        csp = (
            "default-src 'self'; "
            "img-src 'self' data:; "
            "font-src 'self' data:; "
            "media-src 'self' data:; "
            "script-src 'self' blob:; "
            "worker-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; "
            "object-src 'none'; frame-ancestors 'none'; base-uri 'self'; manifest-src 'self'"
        )
        # Only set if not already (allow tests to override)
        resp.headers.setdefault('Content-Security-Policy', csp)
        # Basic favicon fallbacks if not present
        if 'Link' not in resp.headers:
            resp.headers.add('Link', '</static/images/favicon.ico>; rel="icon"')
        return resp

    # ------------------------------------------------------------------
    # Error Handlers (generic safe messages)
    # ------------------------------------------------------------------
    @app.errorhandler(404)
    def _not_found(e):
        return jsonify({"error": "not_found"}), 404

    @app.errorhandler(429)
    def _rate_limited(e):
        return jsonify({"error": "rate_limited"}), 429

    @app.errorhandler(500)
    def _server_error(e):
        app.logger.exception("Unhandled server error")
        return jsonify({"error": "internal_server_error"}), 500
    # # Init MongoDB
    # try:
    #     db_name = app.config['MONGODB_SETTINGS']['db']
    #     username = app.config['MONGODB_SETTINGS']['username']
    #     password = app.config['MONGODB_SETTINGS'].get('password')
    #     host = app.config['MONGODB_SETTINGS'].get('host')
    #     port = app.config['MONGODB_SETTINGS'].get('port')
    #     auth_source = app.config['MONGODB_SETTINGS'].get('auth_source')

    #     # Construct the connection string
    #     connection_string = f"mongodb://{host}:{port}/{db_name}?authSource={auth_source}"

    #     mongo(host=connection_string)
    #     # mongo(**app.config['MONGODB_SETTINGS'])
    #     app.logger.info("MongoDB connected: %s", connection_string)

    #     # Extract parameters from connection string
    #     client = MongoClient(connection_string)
    #     # Run a ping command
    #     client.admin.command('ping')
    #     print("✅ MongoDB connection successful.")
    #     app.logger.info("✅ MongoDB connection successful.")

    # except ConnectionFailure as e:
    #     app.logger.error("❌ MongoDB connection failed: %s", e)
    # except Exception as e:
    #     app.logger.exception("❌ MongoDB connection failed: %s", e)

    Compress(app)
    CORS(app,supports_credentials=True)
    app.logger.info("Middleware loaded: Compress, CORS")

    start_hls_worker(app)

    try:
        register_blueprints(app)
        app.logger.info("Blueprints registered.")
    except Exception as e:
        app.logger.exception("Error registering blueprints: %s", e)

    # Favicon route to eliminate 404 /favicon.ico requests
    @app.route('/favicon.ico')
    def favicon():
        static_dir = os.path.join(app.root_path, 'static')
        # Prefer root static/favicon.ico; fallback to images/favicon.ico
        if os.path.exists(os.path.join(static_dir, 'favicon.ico')):
            return send_from_directory(static_dir, 'favicon.ico', mimetype='image/vnd.microsoft.icon')
        images_dir = os.path.join(static_dir, 'images')
        return send_from_directory(images_dir, 'favicon.ico', mimetype='image/vnd.microsoft.icon')

    app.logger.info("✅ Flask app created successfully.")
    return app
