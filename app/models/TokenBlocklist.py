# models.py
from datetime import datetime, timezone, timedelta
from sqlalchemy import Column, String, DateTime, Index
from app.extensions import db


class TokenBlocklist(db.Model):
    """
    Stores revoked JWT tokens by their JTI with expiry.
    Works with SQLAlchemy. Add background job or DB TTL logic for expires_at.
    """
    __tablename__ = 'token_blocklist'

    id = db.Column(db.Integer, primary_key=True)
    jti = db.Column(String(36), unique=True, nullable=False)
    created_at = db.Column(DateTime, default=lambda: datetime.now(
        timezone.utc), nullable=False)
    expires_at = db.Column(DateTime, nullable=False)

    # Optional: Index on expires_at (for cleanup queries)
    __table_args__ = (
        Index('ix_token_expires_at', 'expires_at'),
    )
