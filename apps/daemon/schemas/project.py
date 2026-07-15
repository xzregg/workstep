"""Project API schemas."""

from schemas.base import BaseSchema


class InitRequest(BaseSchema):
    path: str


class RegisterRequest(BaseSchema):
    path: str
