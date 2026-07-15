"""Project API schemas."""

from schemas.base import BaseSchema


class InitRequest(BaseSchema):
    path: str
    name: str | None = None  # Display name, defaults to directory name


class RegisterRequest(BaseSchema):
    path: str
    name: str | None = None


class RenameRequest(BaseSchema):
    path: str
    name: str
