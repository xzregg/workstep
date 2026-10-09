from sqlalchemy import Integer, String, Float, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column
from .base import Base


class CompletionNotification(Base):
    __tablename__ = 'completion_notifications'
    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_key: Mapped[str] = mapped_column(String(64), unique=True)
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), index=True)
    host_project_id: Mapped[str] = mapped_column(String(128), index=True)
    project_name: Mapped[str] = mapped_column(String(256))
    payload_json: Mapped[str] = mapped_column(Text)
    occurred_at: Mapped[float] = mapped_column(Float, index=True)


class NotificationReadCursor(Base):
    __tablename__ = 'notification_read_cursors'
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    through: Mapped[int] = mapped_column(Integer, default=0)
