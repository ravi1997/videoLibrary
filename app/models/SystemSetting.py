from datetime import datetime, timezone
from app.extensions import db


class SystemSetting(db.Model):
    __tablename__ = 'system_settings'
    key = db.Column(db.String(64), primary_key=True)
    value = db.Column(db.Text, nullable=True)
    updated_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    @staticmethod
    def get(key, default=None):
        inst = SystemSetting.query.filter_by(key=key).first()
        return inst.value if inst else default

    @staticmethod
    def set(key, value):
        inst = SystemSetting.query.filter_by(key=key).first()
        if not inst:
            inst = SystemSetting(key=key, value=value)
            db.session.add(inst)
        else:
            inst.value = value
        db.session.commit()
