"""Device identity. Sync operations are called in API/prompt worker threads."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from services.config import config_store


LEGACY_PROACTIVE_INSTRUCTION = "跟进明确交办的事项，完成或需要用户介入时才通知，无变化保持静默。"


class DigitalRoleReference(BaseModel):
    kind: Literal['role', 'team']
    id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')


class DigitalPersonProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    enabled: bool = False
    name: str = Field(default="小研", min_length=1, max_length=80)
    role_binding: DigitalRoleReference | None = None
    role: str = Field(default="研发伙伴", max_length=200)
    personality: str = Field(default="严谨、好奇，表达直接。", max_length=2000)
    relationship_style: Literal["balanced", "warm", "reserved", "tsundere"] = "balanced"
    relationship_preferences: str = Field(default="", max_length=2000)
    tone: str = Field(default="", max_length=1000)
    duties: str = Field(default="协助研发，跟进未完成事项。", min_length=1, max_length=8000)
    avatar: Literal["robot", "spark"] = "robot"
    greeting: str = Field(default="今天有什么需要一起推进的？", max_length=500)
    conversation_rules: str = Field(default="", max_length=8000)
    proactive_enabled: bool = False
    reflection_enabled: bool = True
    memory_batch_size: int = Field(default=100, ge=1, le=1000)
    proactive_shared_context: bool = True
    proactive_instruction: str = Field(default="", max_length=4000)
    quiet_start: int = Field(default=22, ge=0, le=23)
    quiet_end: int = Field(default=8, ge=0, le=23)
    onboarding_completed: bool = False
    show_panel: bool = True
    floating: bool = False
    auto_speak: bool = False
    voice_name: str = Field(default="", max_length=200)
    voice_rate: float = Field(default=1, ge=.5, le=2)
    expression: Literal["neutral", "happy", "concern"] = "neutral"
    proactive_interval_minutes: int = Field(default=5, ge=1, le=1440)
    proactive_contact_interval_minutes: int = Field(default=5, ge=1, le=1440)
    # Legacy configuration accepted for older clients; no independent poller.
    delegation_interval_seconds: int = Field(default=60, ge=1, le=300)


def get_profile() -> DigitalPersonProfile:
    return DigitalPersonProfile.model_validate(config_store.get("digital_person", {}))


def save_profile(profile: DigitalPersonProfile) -> DigitalPersonProfile:
    if profile.role_binding:
        from agent_assistants.chat_roles import resolve_binding
        _, prompt = resolve_binding(profile.role_binding.model_dump())
        if len(prompt) > 8000:
            raise ValueError('角色提示词超过数字人预算，请精简')
    config_store.set("digital_person", profile.model_dump())
    return profile


def prompt_for_project(project) -> str:
    from services.customization_workspace import is_default_workspace
    if project is None or not is_default_workspace(project):
        return ""
    profile = get_profile()
    if not profile.enabled:
        return ""
    role, duties = profile.role, profile.duties
    if profile.role_binding:
        from agent_assistants.chat_roles import resolve_binding
        role, duties = resolve_binding(profile.role_binding.model_dump())
        if len(duties) > 8000:
            raise ValueError('角色提示词超过数字人预算，请精简')
    identity = "\n".join(("[WorkStep digital person]", f"Name: {profile.name}",
                       f"Role: {role}", f"Personality: {profile.personality}",
                       *([f"Tone: {profile.tone}"] if profile.tone else []),
                       f"Duties: {duties}",
                       "For historical recall, stored knowledge, or user preferences missing from current context, use the workstep-cli memory tools; see the workstep-cli skill and references/memory.md as needed. For overviews, omit --with-sources; fetch originals only to verify specific wording or context. Reuse retrieved results and stop when sufficient.",
                       "HARD BOUNDARY: You only communicate, clarify, delegate, and check progress. Never execute task work in this conversation, even small tasks. Code or file changes, builds, tests, browser operations, and other actual work MUST run in a separate execution session in the target project via the workstep-cli skill. Use tools here only to discover context, delegate, or query status/results. If delegation fails, report the blocker; never do the work yourself as a fallback. After delegation, promptly acknowledge and return; the background service follows up. Reuse the request identifier on retries. Respond in the user's language unless requested otherwise."))
    return f"{identity}\nConversation rules: {profile.conversation_rules}" if profile.conversation_rules else identity


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
