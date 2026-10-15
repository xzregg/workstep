"""Prompt assets, deliberately independent from execution configuration."""
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

class AssetFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    prompt: str = Field(default="", max_length=200_000)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value):
        if not value.strip():
            raise ValueError("名称不能为空")
        return value.strip()


class RoleFields(AssetFields):
    category: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=200_000)

    @field_validator("category")
    @classmethod
    def nonblank_category(cls, value):
        if not value.strip():
            raise ValueError("分类不能为空")
        return value.strip()

    @field_validator("prompt")
    @classmethod
    def nonblank_prompt(cls, value):
        if not value.strip():
            raise ValueError("角色提示词不能为空")
        return value


class RoleWrite(RoleFields):
    expected_revision: str = Field(default="", pattern=r"^(?:[a-f0-9]{64})?$")


class TeamMember(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    duty: str = Field(default="", max_length=4000)


class TeamFields(AssetFields):
    members: list[TeamMember] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_members(self):
        ids = [member.role_id for member in self.members]
        if len(ids) != len(set(ids)):
            raise ValueError("同一角色不能重复加入专家团")
        return self


class TeamWrite(TeamFields):
    expected_revision: str = Field(default="", pattern=r"^(?:[a-f0-9]{64})?$")


class RoleDocument(RoleFields):
    id: str
    builtin: bool = False
    source: dict | None = None
    updated_at: str = ""


class TeamDocument(TeamFields):
    id: str
    updated_at: str = ""
