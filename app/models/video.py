import datetime
import uuid

# ✅ correct import for Postgres UUID
from sqlalchemy.dialects.postgresql import UUID
from app.models.enumerations import VideoStatus
from app.models.User import User
from app.extensions import db


class Video(db.Model):
    __tablename__ = 'videos'

    uuid = db.Column(db.String(36), primary_key=True,
                     default=lambda: str(uuid.uuid4()))
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, nullable=True)
    transcript = db.Column(db.Text, nullable=True)
    file_path = db.Column(db.String(255), nullable=False)
    original_file_path = db.Column(db.String(255), nullable=False)
    md5 = db.Column(db.String(32), nullable=True, default=None)

    # ✅ give the Enum a name so Alembic can manage it cleanly in Postgres
    status = db.Column(db.Enum(VideoStatus, name='videostatus'),
                       default=VideoStatus.PENDING, nullable=False)

    created_at = db.Column(
        db.DateTime, server_default=db.func.current_timestamp(), nullable=False)
    updated_at = db.Column(
        db.DateTime,
        server_default=db.func.current_timestamp(),
        onupdate=db.func.current_timestamp(),
        nullable=False
    )

    views = db.Column(db.Integer, default=0, nullable=True)
    
    # ✅ user_id must be UUID to match users.id
    user_id = db.Column(UUID(as_uuid=True), db.ForeignKey(
        'users.id'), nullable=False)
    # ✅ specify foreign_keys to avoid ambiguous relationship paths
    user = db.relationship(User, back_populates='videos',
                           foreign_keys=[user_id])

    # Many-to-many: Video <-> Tag via association table 'video_tags'
    tags = db.relationship(
        'Tag',
        secondary='video_tags',
        back_populates='videos'
    )

    # Category (many videos to one category)
    category_id = db.Column(db.Integer, db.ForeignKey(
        'categories.id'), nullable=True)
    category = db.relationship('Category', back_populates='videos')

    # Many-to-many: Video <-> Surgeon via 'video_surgeons'
    surgeons = db.relationship(
        'Surgeon',
        secondary='video_surgeons',
        back_populates='videos'
    )

    duration = db.Column(db.Float, nullable=True, default=0.0)

    favourites = db.relationship('Favourite', back_populates='video')

    def __repr__(self):
        return f"<Video {self.title} - {self.status}>"


class VideoTag(db.Model):
    """
    Association table for many-to-many Video <-> Tag.
    Note: Don't define back_populates here that point to the high-level many-to-many;
    let Video.tags and Tag.videos manage the relationship via 'secondary'.
    """
    __tablename__ = 'video_tags'

    video_id = db.Column(db.String(36), db.ForeignKey(
        'videos.uuid'), primary_key=True)
    tag_id = db.Column(db.Integer, db.ForeignKey('tags.id'), primary_key=True)


class Tag(db.Model):
    __tablename__ = 'tags'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), unique=True, nullable=False)

    videos = db.relationship(
        'Video',
        secondary='video_tags',
        back_populates='tags'
    )

    def __repr__(self):
        return f"<Tag {self.name}>"


class Category(db.Model):
    __tablename__ = 'categories'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), unique=True, nullable=False)

    videos = db.relationship('Video', back_populates='category')

    def __repr__(self):
        return f"<Category {self.name}>"


class Surgeon(db.Model):
    __tablename__ = 'surgeons'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)

    type = db.Column(db.String(50), nullable=False)
    description = db.Column(db.Text, nullable=True)

    # ✅ must be UUID to reference users.id (uuid)
    user_id = db.Column(UUID(as_uuid=True),
                        db.ForeignKey('users.id'), nullable=True)

    # ✅ one-to-one with User (make sure User.surgeon exists with uselist=False)
    user = db.relationship(
        'User',
        back_populates='surgeon',
        foreign_keys=[user_id],
        uselist=False
    )

    # Many-to-many with Video
    videos = db.relationship(
        'Video',
        secondary='video_surgeons',
        back_populates='surgeons'
    )

    def __repr__(self):
        return f"<Surgeon {self.name}>"


class VideoSurgeon(db.Model):
    """
    Association table for many-to-many Video <-> Surgeon.
    Keep this simple; high-level relationships are defined on Video.surgeons and Surgeon.videos.
    """
    __tablename__ = 'video_surgeons'

    video_id = db.Column(db.String(36), db.ForeignKey(
        'videos.uuid'), primary_key=True)
    surgeon_id = db.Column(db.Integer, db.ForeignKey(
        'surgeons.id'), primary_key=True)


class VideoProgress(db.Model):
    __tablename__ = 'video_progress'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(UUID(as_uuid=True), nullable=False)
    video_id = db.Column(db.String(36), nullable=False)
    position = db.Column(db.Float, default=0)
    updated_at = db.Column(
        db.DateTime,
        server_default=db.func.current_timestamp(),
        onupdate=db.func.current_timestamp(),
        nullable=False
    )


    __table_args__ = (
        db.UniqueConstraint('user_id', 'video_id', name='unique_user_video'),
    )
    
class Favourite(db.Model):
    __tablename__ = 'favourites'

    user_id = db.Column(UUID(as_uuid=True), db.ForeignKey('users.id'), primary_key=True)
    video_id = db.Column(db.String(36), db.ForeignKey('videos.uuid'), primary_key=True)

    user = db.relationship('User', back_populates='favourites')
    video = db.relationship('Video', back_populates='favourites')


class VideoViewEvent(db.Model):
    __tablename__ = 'video_view_events'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(UUID(as_uuid=True), db.ForeignKey('users.id'), nullable=False, index=True)
    video_id = db.Column(db.String(36), db.ForeignKey('videos.uuid'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.current_timestamp(), index=True)

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': str(self.user_id),
            'video_id': self.video_id,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }


# -------------------- Playlists --------------------
class Playlist(db.Model):
    __tablename__ = 'playlists'

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    is_public = db.Column(db.Boolean, nullable=False, default=False, index=True)
    owner_id = db.Column(UUID(as_uuid=True), db.ForeignKey('users.id'), nullable=True, index=True)
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.current_timestamp())
    updated_at = db.Column(db.DateTime, nullable=False, server_default=db.func.current_timestamp(), onupdate=db.func.current_timestamp())

    items = db.relationship('PlaylistItem', back_populates='playlist', cascade='all, delete-orphan', order_by='PlaylistItem.position')

    def to_dict(self, with_counts: bool = True):
        d = {
            'id': self.id,
            'title': self.title,
            'description': self.description or '',
            'is_public': bool(self.is_public),
            'owner_id': str(self.owner_id) if self.owner_id else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }
        if with_counts:
            try:
                d['items'] = len(self.items)
            except Exception:
                d['items'] = 0
        return d


class PlaylistItem(db.Model):
    __tablename__ = 'playlist_items'

    id = db.Column(db.Integer, primary_key=True)
    playlist_id = db.Column(db.Integer, db.ForeignKey('playlists.id', ondelete='CASCADE'), nullable=False, index=True)
    video_id = db.Column(db.String(36), db.ForeignKey('videos.uuid'), nullable=False, index=True)
    position = db.Column(db.Integer, nullable=False, default=0, index=True)
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.current_timestamp())

    playlist = db.relationship('Playlist', back_populates='items')
    video = db.relationship('Video', primaryjoin='foreign(PlaylistItem.video_id)==Video.uuid')

    __table_args__ = (
        db.UniqueConstraint('playlist_id', 'video_id', name='uq_playlist_video'),
    )

    def to_dict(self, with_video=True):
        d = {
            'id': self.id,
            'playlist_id': self.playlist_id,
            'video_id': self.video_id,
            'position': self.position,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }
        if with_video and self.video:
            d['video'] = {
                'uuid': self.video.uuid,
                'title': self.video.title,
                'duration': float(self.video.duration or 0.0),
                'views': int(self.video.views or 0),
                'created_at': self.video.created_at.isoformat() if self.video.created_at else None,
            }
        return d
