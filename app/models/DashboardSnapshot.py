from datetime import date, datetime, timezone
from app.extensions import db

class DashboardDailySnapshot(db.Model):
    __tablename__ = 'dashboard_daily_snapshots'

    day = db.Column(db.Date, primary_key=True, nullable=False)
    total_views = db.Column(db.BigInteger, nullable=False, default=0)
    total_videos = db.Column(db.Integer, nullable=False, default=0)
    total_users = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    @staticmethod
    def upsert_today(views:int, videos:int, users:int):
        today = date.today()
        snap = db.session.get(DashboardDailySnapshot, today)
        if not snap:
            snap = DashboardDailySnapshot(day=today, total_views=views, total_videos=videos, total_users=users)
            db.session.add(snap)
        else:
            # update if changed (avoid write churn)
            changed = False
            if snap.total_views != views:
                snap.total_views = views; changed = True
            if snap.total_videos != videos:
                snap.total_videos = videos; changed = True
            if snap.total_users != users:
                snap.total_users = users; changed = True
            if not changed:
                return snap
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
        return snap
