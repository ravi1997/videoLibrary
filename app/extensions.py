

from flask_sqlalchemy import SQLAlchemy
from flask_marshmallow import Marshmallow

from faker import Faker
from flask_migrate import Migrate

# extensions.py
from mongoengine import connect

mongo = connect  # alias for clarity in create_app

fake = Faker()

from flask_jwt_extended import JWTManager
jwt = JWTManager()


db = SQLAlchemy()
migrate = Migrate(db=db)

ma = Marshmallow()