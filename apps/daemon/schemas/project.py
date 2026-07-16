"""Project API schemas."""

from typing import Any
from schemas.base import BaseSchema


class InitRequest(BaseSchema):
    path: str
    name: str | None = None


class RegisterRequest(BaseSchema):
    path: str
    name: str | None = None


class RenameRequest(BaseSchema):
    path: str
    name: str


class SaveStepsRequest(BaseSchema):
    path: str
    steps: dict[str, Any]  # The full steps.json content
