import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from sqlalchemy import Index
from app.extensions import db
from sqlalchemy.dialects.postgresql import UUID


class RefreshToken(db.Model):
    __tablename__ = 'refresh_tokens'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(UUID(as_uuid=True), db.ForeignKey('users.id'), nullable=False, index=True)
    token_hash = db.Column(db.String(128), unique=True, nullable=False)  # sha256 hex
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    expires_at = db.Column(db.DateTime, nullable=False)
    revoked = db.Column(db.Boolean, nullable=False, default=False)
    replaced_by_id = db.Column(db.Integer, db.ForeignKey('refresh_tokens.id'), nullable=True)
    user_agent = db.Column(db.String(256))  # optional metadata
    ip_address = db.Column(db.String(64))   # optional metadata

    replaced_by = db.relationship('RefreshToken', remote_side=[id], uselist=False)

    __table_args__ = (
        Index('ix_refresh_tokens_expires_at', 'expires_at'),
    )

    @staticmethod
    def generate_plain_token() -> str:
        return secrets.token_urlsafe(48)

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.encode('utf-8')).hexdigest()

    @classmethod
    def create_for_user(cls, user_id, ttl: timedelta, user_agent: str = None, ip: str = None):
        plain = cls.generate_plain_token()
        token_hash = cls.hash_token(plain)
        inst = cls(
            user_id=user_id,
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + ttl,
            user_agent=(user_agent or '')[:256],
            ip_address=(ip or '')[:64]
        )
        db.session.add(inst)
        return inst, plain

    def revoke(self, replaced_by=None):
        self.revoked = True
        if replaced_by:
            self.replaced_by_id = replaced_by.id

    def is_active(self) -> bool:
        now = datetime.now(timezone.utc)
        exp = self.expires_at
        if exp and exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return (not self.revoked) and exp > now
