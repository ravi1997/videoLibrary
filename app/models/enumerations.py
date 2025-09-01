# enums.py
from enum import Enum


class UserType(str, Enum):
    EMPLOYEE = 'employee'
    GENERAL = 'general'


class Role(str, Enum):
    SUPERADMIN = 'superadmin'
    ADMIN = 'admin'
    USER = 'user'
    UPLOADER = 'uploader'
    APPROVER = 'approver'
    VIEWER = 'viewer'
    GENERAL = 'general'


class VideoStatus(str, Enum):
    PENDING = 'pending'
    PROCESSED = 'processed'
    PUBLISHED = 'published'
    REJECTED = 'rejected'
    DELETED = 'deleted'
    ARCHIVED = 'archived'
    FAILED = 'failed'


class THEME_CHOICES(str, Enum):
    LIGHT = 'light'
    DARK = 'dark'
    SYSTEM = 'system'

class VIDEO_QUALITY(str, Enum):
    AUTO = 'auto'
    _360P = '360p'
    _480P = '480p'
    _720P = '720p'
    _1080P = '1080p'
    _1440P = '1440p'
    _2160P = '2160p'

class VIDEO_SPEED(str, Enum):
    _0_5X = '0.5x'
    _1_0X = '1.0x'
    _1_25X = '1.25x'
    _1_5X = '1.5x'
    _2X = '2.0x'