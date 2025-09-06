import bcrypt
from marshmallow import Schema, fields, validate, post_load, EXCLUDE
from sqlalchemy import null
from app.models.User import User, UserSettings, UserType, Role
from marshmallow_enum import EnumField

from app.models.enumerations import THEME_CHOICES, VIDEO_QUALITY, VIDEO_SPEED
from app.extensions import ma


class UserSchema(Schema):
    class Meta:
        unknown = EXCLUDE  # Ignore extra fields on load

    id = fields.String(dump_only=True)
    username = fields.String(required=True, validate=validate.Length(min=3, max=50))
    email = fields.Email(required=True)
    mobile = fields.String(required=True, validate=validate.Length(min=10))
    employee_id = fields.String(required=False, allow_none=True)
    roles = fields.List(
        fields.String(validate=validate.OneOf([r.value for r in Role])),
        required=True
    )
    
    # Auth & status
    password = fields.String(load_only=True, required=True)
    is_active = fields.Boolean(dump_only=True)
    is_admin = fields.Boolean(dump_only=True)
    is_email_verified = fields.Boolean(dump_only=True)
    last_login = fields.DateTime(dump_only=True)
    created_at = fields.DateTime(dump_only=True)
    updated_at = fields.DateTime(dump_only=True)

    # OTP-related fields (only shown if explicitly needed)
    otp = fields.String(allow_none=True)
    otp_expiration = fields.DateTime(allow_none=True)
    failed_login_attempts = fields.Integer(dump_only=True)
    otp_resend_count = fields.Integer(dump_only=True)
    lock_until = fields.DateTime(dump_only=True)
    password_expiration = fields.DateTime(dump_only=True)

    @post_load
    def make_user(self, data, **kwargs):
        # Do not hash password here to avoid bypassing policy and double-hashing.
        # Route logic should call User.set_password() which enforces strength
        # and updates password metadata. We drop the plain password from the
        # deserialized payload so it isn't passed into the model constructor.
        if 'password' in data:
            data.pop('password', None)
        user = User(**data)
        return user


class UserSettingsSchema(ma.SQLAlchemyAutoSchema):
    class Meta:
        model = UserSettings
        unknown = EXCLUDE  # Ignore extra fields on load
        load_instance = True
        include_fk = True
        # Unknown fields are excluded to keep input strict
        include_relationships = False

    # override types/validators
    theme = fields.String(
        required=False, validate=validate.OneOf([e.value for e in THEME_CHOICES]))
    compact = fields.Boolean(required=False)

    autoplay = fields.Boolean(required=False)
    quality = fields.String(
        required=False, validate=validate.OneOf([e.value for e in VIDEO_QUALITY]))
    speed = fields.String(
        required=False, validate=validate.OneOf([e.value for e in VIDEO_SPEED]))

    email_updates = fields.Boolean(required=False)
    weekly_digest = fields.Boolean(required=False)

    private_profile = fields.Boolean(required=False)
    personalize = fields.Boolean(required=False)

    # read-only
    updated_at = fields.DateTime(dump_only=True)
    user_id = fields.Str(dump_only=True)
