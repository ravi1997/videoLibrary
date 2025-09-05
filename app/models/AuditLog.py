import uuid
from datetime import datetime, timezone
from app.extensions import db


class AuditLog(db.Model):
    __tablename__ = 'audit_logs'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    event = db.Column(db.String(64), nullable=False)
    user_id = db.Column(db.String(64), nullable=True)  # actor
    target_user_id = db.Column(db.String(64), nullable=True)
    ip = db.Column(db.String(64), nullable=True)
    detail = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

    def to_dict(self):
        return {
            'id': self.id,
            'event': self.event,
            'user_id': self.user_id,
            'target_user_id': self.target_user_id,
            'ip': self.ip,
            'detail': self.detail,
            'created_at': self.created_at.isoformat(),
        }
