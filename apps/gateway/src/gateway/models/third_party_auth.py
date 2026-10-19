"""Single-use codes for third-party website sign-in."""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class ThirdPartyAuthCode(Base):
    __tablename__ = 'third_party_auth_codes'

    code_hash: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_id_hash: Mapped[str] = mapped_column(String(128))
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    callback: Mapped[str] = mapped_column(String(2048))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
