"""Base schema for all Pydantic request/response models."""

from pydantic import BaseModel


class BaseSchema(BaseModel):
    """Base class for API schemas. Use this instead of pydantic.BaseModel directly."""
    pass
