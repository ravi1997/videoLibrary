# schemas/video_schema.py

import uuid
from app.models import (
    Video, VideoTag, Tag, Category, Surgeon, VideoSurgeon, User
)
from app.models.enumerations import VideoStatus
from app.extensions import ma


# ------------------------------------------------------------------------------
# Marshmallow Schemas (pure read/serialize for now)
# ------------------------------------------------------------------------------

from marshmallow import Schema, ValidationError, fields, post_dump, validates

from marshmallow_sqlalchemy import SQLAlchemySchema, auto_field

class TagSchema(ma.SQLAlchemyAutoSchema):
    class Meta:
        model = Tag
        load_instance = True
        include_fk = True  # Allows auto_field to include foreign keys


class CategorySchema(ma.SQLAlchemyAutoSchema):
    class Meta:
        model = Category
        load_instance = True
        include_fk = True  # Allows auto_field to include foreign keys

class SurgeonSchema(ma.SQLAlchemyAutoSchema):
    class Meta:
        model = Surgeon
        load_instance = True  # Return a model instance
        include_fk = True     # Allows auto_field to include foreign keys


class UserSchema(Schema):
    id = fields.Int()
    username = fields.Str()
    email = fields.Str()  # keep if present on User model


class VideoMiniSchema(Schema):
    uuid = fields.Str()
    title = fields.Str()
    user = fields.Nested(UserSchema)
    views = fields.Int()
    duration = fields.Float()
    created_at = fields.DateTime(format="%Y-%m-%d %H:%M:%S")
    category = fields.Nested(CategorySchema)


    @post_dump
    def add_thumbnail_url(self, data, **kwargs):
        data["thumbnail"] = f"/api/v1/video/thumbnails/{data['uuid']}.jpg"
        return data


class VideoMetaInputSchema(ma.SQLAlchemyAutoSchema):
    class Meta:
        model = Video
        load_instance = True  # Return a model instance
        include_fk = True     # Allows auto_field to include foreign keys
    
    category = fields.Nested(CategorySchema, required=False)
    tags = fields.List(fields.Nested(TagSchema), required=False)
    surgeons = fields.List(fields.Nested(SurgeonSchema), required=False)
    
