"""Project API schemas."""

import re
from typing import Any

from pydantic import field_validator

from schemas.base import BaseSchema


_WHITESPACE_RE = re.compile(r"\s")


def _reject_whitespace(value: str) -> str:
    """Reject names containing whitespace (space, tab, etc.)."""
    if _WHITESPACE_RE.search(value):
        raise ValueError("名称不能包含空白字符（空格、Tab 等）")
    return value


class InitRequest(BaseSchema):
    path: str
    name: str | None = None

    @field_validator("name")
    @classmethod
    def _init_name_no_whitespace(cls, v: str | None) -> str | None:
        if v:
            _reject_whitespace(v)
        return v


class RegisterRequest(BaseSchema):
    path: str
    name: str | None = None

    @field_validator("name")
    @classmethod
    def _register_name_no_whitespace(cls, v: str | None) -> str | None:
        if v:
            _reject_whitespace(v)
        return v


class RenameRequest(BaseSchema):
    path: str
    name: str

    @field_validator("name")
    @classmethod
    def _rename_name_no_whitespace(cls, v: str) -> str:
        return _reject_whitespace(v)


class ReorderProjectsRequest(BaseSchema):
    ordered_ids: list[str]


class SaveStepsRequest(BaseSchema):
    steps: dict[str, Any]  # The full workflow definition


class CreateWorkflowRequest(BaseSchema):
    name: str
    steps: dict[str, Any] | None = None
    template_id: str | None = None
    is_default: bool = False

    @field_validator("name")
    @classmethod
    def _create_workflow_name_no_whitespace(cls, v: str) -> str:
        return _reject_whitespace(v)


class UpdateWorkflowRequest(BaseSchema):
    name: str | None = None
    steps: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def _update_workflow_name_no_whitespace(cls, v: str | None) -> str | None:
        if v:
            _reject_whitespace(v)
        return v


class UpdateStepPromptRequest(BaseSchema):
    prompt: str
