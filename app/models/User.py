# models/user.py

import uuid
import bcrypt
import logging
from enum import Enum
from datetime import datetime, timedelta, timezone
from sqlalchemy.ext.associationproxy import association_proxy
from sqlalchemy import (
    Column, String, Boolean, DateTime, Integer, Enum as SqlEnum, Table, ForeignKey
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from flask import current_app

from app.models.enumerations import Role, UserType

from ..extensions import db

logger = logging.getLogger("auth")

# --- Constants ---
MAX_FAILED_ATTEMPTS = 5
MAX_OTP_RESENDS = 5
LOCK_DURATION_HOURS = 24
PASSWORD_EXPIRATION_DAYS = 90

# --- Association Table for User Roles ---


class UserRole(db.Model):
    __tablename__ = "user_roles"
    user_id = db.Column(UUID(as_uuid=True), db.ForeignKey(
        "users.id"), primary_key=True)
    role = db.Column(SqlEnum(Role), nullable=False, primary_key=True)

    user = db.relationship("User", back_populates="role_associations")

# --- User Model ---


class User(db.Model):
    __tablename__ = 'users'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username = Column(String(50), unique=True)
    email = Column(String(120), unique=True)
    employee_id = Column(String(30), unique=True)
    mobile = Column(String(15), unique=True)

    user_type = Column(SqlEnum(UserType), nullable=False)
    password_hash = Column(String(255))
    password_expiration = Column(DateTime)

    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    is_email_verified = Column(Boolean, default=False)

    failed_login_attempts = Column(Integer, default=0)
    otp_resend_count = Column(Integer, default=0)
    lock_until = Column(DateTime)
    last_login = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(
        timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    otp = Column(String(6))
    otp_expiration = Column(DateTime)

    videos = db.relationship(
        'Video', back_populates='user', foreign_keys='Video.user_id')
    surgeon = db.relationship(
        'Surgeon', back_populates='user', foreign_keys='Surgeon.user_id', uselist=False)

    # --- Relationships ---
    role_associations = db.relationship(
        "UserRole", back_populates="user", cascade="all, delete-orphan")
    roles = association_proxy("role_associations", "role")

    favourites = db.relationship('Favourite', back_populates='user')

    # --- Security Methods ---

    def is_locked(self) -> bool:
        return self.lock_until and datetime.now(timezone.utc) < self.lock_until

    def lock_account(self):
        self.lock_until = datetime.now(
            timezone.utc) + timedelta(hours=LOCK_DURATION_HOURS)
        logger.warning(f"User {self.id} locked until {self.lock_until}")

    def unlock_account(self):
        self.lock_until = None
        self.failed_login_attempts = 0
        self.otp_resend_count = 0
        logger.info(f"User {self.id} manually unlocked")

    def increment_failed_logins(self):
        if self.is_locked():
            return
        self.failed_login_attempts += 1
        if self.failed_login_attempts >= MAX_FAILED_ATTEMPTS:
            self.lock_account()

    def reset_failed_logins(self):
        self.failed_login_attempts = 0

    def resend_otp(self):
        if self.is_locked():
            return
        self.otp_resend_count += 1
        if self.otp_resend_count >= MAX_OTP_RESENDS:
            self.lock_account()

    def set_otp(self, otp_code: str, ttl_minutes: int = 5):
        self.otp = otp_code
        self.otp_expiration = datetime.now(
            timezone.utc) + timedelta(minutes=ttl_minutes)
        self.otp_resend_count = 0

    def verify_otp(self, code: str) -> bool:
        current_app.logger.info(
            f"Verifying OTP for user {self.id}. Provided: {code}, Expected: {self.otp}")
        if self.is_locked():
            current_app.logger.warning(
                f"OTP verification failed: user {self.id} is locked.")
            return False

        otp_exp = self.otp_expiration
        if otp_exp and otp_exp.tzinfo is None:
            otp_exp = otp_exp.replace(tzinfo=timezone.utc)

        if not otp_exp or otp_exp <= datetime.now(timezone.utc):
            return False

        if self.otp != code:
            return False

        return True

    def set_password(self, raw_password: str):
        salt = bcrypt.gensalt()
        self.password_hash = bcrypt.hashpw(
            raw_password.encode(), salt).decode()
        self.password_expiration = datetime.now(
            timezone.utc) + timedelta(days=PASSWORD_EXPIRATION_DAYS)

    def check_password(self, raw_password: str) -> bool:
        try:
            return bcrypt.checkpw(raw_password.encode(), self.password_hash.encode())
        except Exception:
            return False

    def is_password_expired(self) -> bool:
        return self.password_expiration and datetime.now(timezone.utc) > self.password_expiration

    # --- Roles ---

    def has_role(self, role: str) -> bool:
        return role in [r.value for r in self.roles]

    def is_superadmin_check(self) -> bool:
        return Role.SUPERADMIN in [r for r in self.roles]

    def is_admin_check(self) -> bool:
        return Role.ADMIN in [r for r in self.roles] or self.is_superadmin_check()

    # --- Authentication (Static) ---

    @staticmethod
    def authenticate(identifier: str, password: str):
        user = User.query.filter(
            User.user_type == UserType.EMPLOYEE,
            User.is_active == True,
            db.or_(
                User.username == identifier,
                User.email == identifier,
                User.employee_id == identifier
            )
        ).first()

        if not user or user.is_locked() or not user.check_password(password) or user.is_password_expired():
            if user:
                user.increment_failed_logins()
            return None

        user.last_login = datetime.now(timezone.utc)
        user.reset_failed_logins()
        db.session.commit()
        return user

    @staticmethod
    def authenticate_with_otp(mobile: str, otp_code: str):
        user = User.query.filter_by(mobile=mobile, is_active=True).first()

        if not user or user.is_locked() or not user.verify_otp(otp_code):
            if user:
                user.increment_failed_logins()
            return None

        user.last_login = datetime.utcnow()
        user.reset_failed_logins()
        db.session.commit()
        return user

    # --- Serialization ---

    def to_dict(self, include_sensitive=False):
        def iso_or_none(dt):
            return dt.isoformat() if dt else None

        data = {
            'id': str(self.id),
            'user_type': self.user_type,
            'username': self.username,
            'email': self.email,
            'employee_id': self.employee_id,
            'mobile': self.mobile,
            'is_active': self.is_active,
            'is_admin': self.is_admin,
            'is_email_verified': self.is_email_verified,
            'roles': [r.value for r in self.roles],
            'failed_login_attempts': self.failed_login_attempts,
            'otp_resend_count': self.otp_resend_count,
            'lock_until': iso_or_none(self.lock_until),
            'created_at': iso_or_none(self.created_at),
            'updated_at': iso_or_none(self.updated_at),
            'last_login': iso_or_none(self.last_login),
            'password_expiration': iso_or_none(self.password_expiration),
        }

        if include_sensitive:
            data.update({
                'password_hash': self.password_hash,
                'otp': self.otp,
                'otp_expiration': iso_or_none(self.otp_expiration),
            })

        return data

    def __str__(self):
        return f"<User(username='{self.username}', type='{self.user_type}')>"


class UserSettings(db.Model):
    __tablename__ = "user_settings"

    # one row per user
    user_id = db.Column(UUID(as_uuid=True), db.ForeignKey(
        'users.id'), nullable=False, primary_key=True)

    # appearance
    # "light" | "dark" | "system"
    theme = db.Column(db.String(16), nullable=False, default="system")
    compact = db.Column(db.Boolean, nullable=False, default=False)

    # playback
    autoplay = db.Column(db.Boolean, nullable=False, default=False)
    # "auto"|"480p"|"720p"|"1080p"|"2160p"
    quality = db.Column(db.String(16), nullable=False, default="auto")
    # store as string for simplicity
    speed = db.Column(db.String(8), nullable=False, default="1.0")

    # notifications
    email_updates = db.Column(db.Boolean, nullable=False, default=False)
    weekly_digest = db.Column(db.Boolean, nullable=False, default=False)

    # privacy
    private_profile = db.Column(db.Boolean, nullable=False, default=False)
    personalize = db.Column(db.Boolean, nullable=False, default=True)

    # housekeeping
    updated_at = db.Column(db.DateTime, nullable=False,
                           default=datetime.utcnow, onupdate=datetime.utcnow)
