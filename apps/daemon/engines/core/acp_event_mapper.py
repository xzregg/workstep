"""Translate ACP session updates into WorkStep internal events."""

from typing import Any

from acp import schema

from engines.core.events import (
    InternalEvent,
    acp_raw_event,
    agent_message_chunk,
    agent_thought_chunk,
    usage_update_event,
    user_message_chunk,
)
from engines.core.plans import plan_event


class ACPEventMapper:
    """Own the ACP notification vocabulary and payload projection."""

    def _map_notification(self, update) -> InternalEvent | None:
        """Map one ACP session update to the internal (ACP-vocabulary) event.

        13 种 session update 全量映射；未知 update 透传 ``acp_raw`` 不再静默丢弃。
        """
        if isinstance(update, InternalEvent):
            return update
        if isinstance(update, schema.AgentMessageChunk):
            text = self._content_text(update.content)
            if text is not None:
                return agent_message_chunk(text)
        if isinstance(update, schema.AgentThoughtChunk):
            text = self._content_text(update.content)
            if text is not None:
                return agent_thought_chunk(text)
        if isinstance(update, schema.UserMessageChunk):
            text = self._content_text(update.content)
            if text is not None:
                return user_message_chunk(text)
        if isinstance(update, schema.ToolCallStart):
            data = {
                "tool_call_id": update.tool_call_id,
                "title": update.title or "tool",
            }
            if update.kind:
                data["kind"] = update.kind
            if update.status:
                data["status"] = update.status
            if update.content is not None:
                data["content"] = self._json_value(update.content)
            if update.locations is not None:
                data["locations"] = self._json_value(update.locations)
            if update.raw_input is not None:
                data["raw_input"] = update.raw_input
            if update.raw_output is not None:
                data["raw_output"] = update.raw_output
            if update.field_meta is not None:
                data["_meta"] = self._json_value(update.field_meta)
            if (self.runtime_permission_mode() or self.get_permission_mode()) == "ask":
                data["needs_approval"] = True
            return InternalEvent(type="tool_call", data=data)
        if isinstance(update, schema.ToolCallProgress):
            data = {"tool_call_id": update.tool_call_id}
            if update.status:
                data["status"] = update.status
            if update.title:
                data["title"] = update.title
            if update.kind:
                data["kind"] = update.kind
            if update.content is not None:
                data["content"] = self._json_value(update.content)
            if update.locations is not None:
                data["locations"] = self._json_value(update.locations)
            if update.raw_input is not None:
                data["raw_input"] = update.raw_input
            if update.raw_output is not None:
                data["raw_output"] = update.raw_output
            if update.field_meta is not None:
                data["_meta"] = self._json_value(update.field_meta)
            return InternalEvent(type="tool_call_update", data=data)
        if isinstance(update, (schema.AgentPlanUpdate, schema.Plan)):
            return plan_event([
                {
                    "content": entry.content,
                    "priority": entry.priority,
                    "status": entry.status,
                }
                for entry in update.entries
            ])
        if isinstance(update, schema.AgentPlanContentUpdate):
            return self._map_plan_update(update)
        if isinstance(update, schema.AgentPlanRemovedUpdate):
            return InternalEvent(type="plan_removed", data={"id": update.id})
        if isinstance(update, schema.UsageUpdate):
            usage: dict[str, Any] = {
                "used": update.used,
                "size": update.size,
            }
            if update.cost is not None:
                usage["cost"] = {
                    "amount": update.cost.amount,
                    "currency": update.cost.currency,
                }
            event = usage_update_event(usage, used=update.used, size=update.size)
            event.data["context_window"] = update.size
            return event
        if isinstance(update, schema.SessionInfoUpdate):
            data: dict[str, Any] = {}
            if update.title is not None:
                data["title"] = update.title
            if update.updatedAt is not None:
                data["updated_at"] = update.updatedAt
            return InternalEvent(type="session_info_update", data=data)
        if isinstance(update, schema.AvailableCommandsUpdate):
            return InternalEvent(
                type="available_commands_update",
                data={"available_commands": [
                    self._json_value(command)
                    for command in (update.availableCommands or [])
                ]},
            )
        if isinstance(update, schema.ConfigOptionUpdate):
            return InternalEvent(
                type="config_option_update",
                data={"config_options": [
                    self._json_value(option)
                    for option in (update.configOptions or [])
                ]},
            )
        if isinstance(update, schema.CurrentModeUpdate):
            return InternalEvent(
                type="current_mode_update",
                data={"current_mode_id": update.currentModeId},
            )
        if isinstance(update, schema.MessageMcpNotification):
            data: dict[str, Any] = {
                "connection_id": update.connectionId,
                "method": update.method,
            }
            if update.params is not None:
                data["params"] = update.params
            return InternalEvent(type="mcp_message", data=data)
        if isinstance(update, schema.CompleteElicitationNotification):
            return InternalEvent(
                type="elicitation_completed",
                data={"elicitation_id": update.elicitationId},
            )
        # 未知 update：透传 acp_raw，不再静默丢弃。
        return acp_raw_event(update)

    @staticmethod
    def _content_text(content) -> str | None:
        if isinstance(content, schema.TextContentBlock):
            return content.text
        return None

    @staticmethod
    def _json_value(value):
        dump = getattr(value, "model_dump", None)
        if callable(dump):
            return dump(by_alias=False, exclude_none=True)
        if isinstance(value, (list, tuple)):
            return [ACPEventMapper._json_value(item) for item in value]
        if isinstance(value, dict):
            return {str(key): ACPEventMapper._json_value(item) for key, item in value.items()}
        return value

    @staticmethod
    def _map_plan_update(update) -> InternalEvent:
        plan = update.plan
        data: dict[str, Any] = {"id": getattr(plan, "id", "")}
        update_type = getattr(plan, "type", None)
        if update_type:
            data["type"] = update_type
        if update_type == "markdown" and getattr(plan, "content", None) is not None:
            data["content"] = plan.content
        elif update_type == "file" and getattr(plan, "uri", None) is not None:
            data["uri"] = plan.uri
        else:
            entries = getattr(plan, "entries", None)
            if entries is not None:
                data["entries"] = [
                    {
                        "content": entry.content,
                        "priority": entry.priority,
                        "status": entry.status,
                    }
                    for entry in entries
                ]
        return InternalEvent(type="plan_update", data=data)

    @staticmethod
    def _map_prompt_response_usage(response) -> InternalEvent | None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        data = {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
            "cached_read_tokens": usage.cached_read_tokens,
            "cached_write_tokens": usage.cached_write_tokens,
        }
        if usage.thought_tokens is not None:
            data["thought_tokens"] = usage.thought_tokens
        return usage_update_event(data)

