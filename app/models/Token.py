import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from sqlalchemy import Index
from sqlalchemy.dialects.postgresql import UUID
from app.extensions import db


class Token(db.Model):
    __tablename__ = 'tokens'

    id = db.Column(db.Integer, primary_key=True)
    token_type = db.Column(db.String(16), nullable=False)  # 'refresh' | 'block'
    # Refresh token fields
    user_id = db.Column(UUID(as_uuid=True), db.ForeignKey('users.id'), nullable=True, index=True)
    token_hash = db.Column(db.String(128), unique=True, nullable=True)  # sha256 hex for refresh
    revoked = db.Column(db.Boolean, nullable=False, default=False)
    replaced_by_id = db.Column(db.Integer, nullable=True)
    user_agent = db.Column(db.String(256))
    ip_address = db.Column(db.String(64))
    # Blocklist field
    jti = db.Column(db.String(64), unique=True, nullable=True)

    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    expires_at = db.Column(db.DateTime, nullable=False)

    __table_args__ = (
        Index('ix_tokens_expires_at', 'expires_at'),
        Index('ix_tokens_type', 'token_type'),
    )

    # ----- Refresh token helpers -----
    @staticmethod
    def generate_plain_token() -> str:
        return secrets.token_urlsafe(48)

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.encode('utf-8')).hexdigest()

    @classmethod
    def create_refresh_for_user(cls, user_id, ttl: timedelta, user_agent: str = None, ip: str = None):
        plain = cls.generate_plain_token()
        token_hash = cls.hash_token(plain)
        inst = cls(
            token_type='refresh',
            user_id=user_id,
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + ttl,
            user_agent=(user_agent or '')[:256],
            ip_address=(ip or '')[:64]
        )
        db.session.add(inst)
        return inst, plain

    def revoke(self, replaced_by=None):
        if self.token_type != 'refresh':
            return
        self.revoked = True
        if replaced_by:
            self.replaced_by_id = replaced_by.id

    def is_active(self) -> bool:
        if self.token_type != 'refresh':
            return False
        now = datetime.now(timezone.utc)
        exp = self.expires_at
        if exp and exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return (not self.revoked) and exp > now

