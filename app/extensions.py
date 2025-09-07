

from flask_sqlalchemy import SQLAlchemy
from flask_marshmallow import Marshmallow

from faker import Faker
from flask_migrate import Migrate

# extensions.py
# MongoDB support was removed during backend simplification. If reintroducing
# Mongo in the future, wire it up here and import in app/__init__.py.

fake = Faker()

from flask_jwt_extended import JWTManager
jwt = JWTManager()


db = SQLAlchemy()
migrate = Migrate(db=db)

ma = Marshmallow()
