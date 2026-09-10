"""Channel-facing assistant using the shared persistent chat runtime."""

from agent_assistants.base import AssistantConfig, SCOPE_CHAT, assistant_registry
from agent_assistants.chat_session import ChatSessionModule


CHANNEL_CHAT_CHANNEL = "channel_chat"

SYSTEM_PROMPT = (
    "你是 WorkStep 的渠道对话助手。回复要简洁、直接、适合即时通讯阅读；"
    "避免复杂排版，默认使用与用户相同的语言。"
)

CHANNEL_CHAT_CONFIG = AssistantConfig(
    name="channel_chat",
    channel=CHANNEL_CHAT_CHANNEL,
    scope=SCOPE_CHAT,
    engine_label="Channel chat engine",
    system_prompt=SYSTEM_PROMPT,
)
assistant_registry.register(CHANNEL_CHAT_CONFIG)


class ChannelChatModule(ChatSessionModule):
    def __init__(
        self,
        event_bus,
        project_manager,
        source_config: AssistantConfig | None = None,
        *,
        register: bool = True,
    ):
        super().__init__(event_bus, project_manager)
        source = source_config or CHANNEL_CHAT_CONFIG
        config = AssistantConfig(
            name=source.name,
            channel=CHANNEL_CHAT_CHANNEL,
            scope=self._config.scope,
            engine_label=source.engine_label,
            system_prompt=source.system_prompt,
            max_history_turns=source.max_history_turns,
            max_sessions=source.max_sessions,
            session_ttl_seconds=source.session_ttl_seconds,
            persistence=self._config.persistence,
            event_journal=self._config.event_journal,
            workstep_tools=source.workstep_tools,
            session_identity=source.session_identity,
            resolve_engine_models=source.resolve_engine_models,
            build_prompt=source.build_prompt,
            parse_response=source.parse_response,
            publish_structured=source.publish_structured,
            extract_streaming_text=source.extract_streaming_text,
            history_message=source.history_message,
            cwd_resolver=source.cwd_resolver,
            validate_engine=source.validate_engine or self._config.validate_engine,
        )
        self._config = config
        if register:
            assistant_registry.register(config)
