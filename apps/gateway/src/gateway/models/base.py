from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


"""Gateway-owned relational schema. Project SQLite models stay in daemon."""


class Base(DeclarativeBase):
    pass


def timestamp() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.current_timestamp())
