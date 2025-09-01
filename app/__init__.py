from flask import Flask
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
    app.cli.add_command(create_user)
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

    app.logger.info("✅ Flask app created successfully.")
    return app
