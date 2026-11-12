"""Device identity. Sync operations are called in API/prompt worker threads."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from services.config import config_store


class DigitalPersonProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    enabled: bool = False
    name: str = Field(default="小研", min_length=1, max_length=80)
    role: str = Field(default="研发伙伴", max_length=200)
    personality: str = Field(default="严谨、好奇，表达直接。", max_length=2000)
    duties: str = Field(default="协助研发，跟进未完成事项。", min_length=1, max_length=8000)
    avatar: Literal["robot", "spark"] = "robot"
    greeting: str = Field(default="今天有什么需要一起推进的？", max_length=500)


def get_profile() -> DigitalPersonProfile:
    return DigitalPersonProfile.model_validate(config_store.get("digital_person", {}))


def save_profile(profile: DigitalPersonProfile) -> DigitalPersonProfile:
    config_store.set("digital_person", profile.model_dump())
    return profile


def prompt_for_project(project) -> str:
    from services.customization_workspace import is_default_workspace
    if project is None or not is_default_workspace(project):
        return ""
    profile = get_profile()
    if not profile.enabled:
        return ""
    return "\n".join(("[WorkStep digital person]", f"姓名：{profile.name}",
                       f"角色：{profile.role}", f"性格：{profile.personality}",
                       f"职责：{profile.duties}"))


class VoiceWakeDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    keyword: str = Field(default="你好小研", min_length=2, max_length=40)
    sensitivity: Literal["low", "balanced", "high"] = "balanced"


def get_voice_wake() -> dict:
    draft = VoiceWakeDraft.model_validate(config_store.get("digital_person_voice_wake", {}))
    return {**draft.model_dump(), "available": False, "listening": False}


def save_voice_wake(draft: VoiceWakeDraft) -> dict:
    config_store.set("digital_person_voice_wake", draft.model_dump())
    return get_voice_wake()
