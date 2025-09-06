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
