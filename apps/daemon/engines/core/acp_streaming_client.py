"""ACP notification queue, permission policy, and elicitation responses."""

import asyncio
import uuid

import acp
from acp import schema

from engines.core.events import InternalEvent, acp_raw_event
from engines.core.interactions import elicitation_request, permission_request


class ACPStreamingClient:
    """Receive ACP notifications and apply the configured permission policy."""

    def __init__(self, permission_mode: str | None = None):
        self.updates: asyncio.Queue = asyncio.Queue()
        self.permission_mode = permission_mode
        # tool_call_id → Future[option_id | None], parked until the UI responds.
        self._approval_futures: dict[str, asyncio.Future[str | None]] = {}
        self._default_allow_options: dict[str, str | None] = {}
        self._elicitation_futures: dict[str, asyncio.Future[dict]] = {}
        self.pending_permissions: list[dict] = []

    @property
    def needs_approval(self) -> bool:
        """Human-in-the-loop mode: every tool call waits for an explicit decision."""
        return self.permission_mode == "ask"

    def resolve_approval(self, tool_call_id: str, approved: bool) -> bool:
        """Resolve a parked permission request; returns False if none is pending."""
        option_id = self._default_allow_options.get(tool_call_id) if approved else None
        return self.resolve_permission(tool_call_id, option_id)

    def resolve_permission(self, tool_call_id: str, option_id: str | None) -> bool:
        """Resolve a parked permission with the exact ACP option selected."""
        future = self._approval_futures.get(tool_call_id)
        if future is None or future.done():
            return False
        future.set_result(option_id)
        return True

    async def session_update(self, session_id, update, **kwargs):
        await self.updates.put(update)

    def resolve_elicitation(
        self,
        interaction_id: str,
        response: dict,
    ) -> bool:
        future = self._elicitation_futures.get(interaction_id)
        if future is None or future.done():
            return False
        future.set_result(response)
        return True

    async def create_elicitation(self, message, mode, **kwargs):
        """Surface ACP form elicitation and await the user's structured input."""
        mode = getattr(mode, "root", mode)
        requested_schema = getattr(mode, "requested_schema", None)
        url = getattr(mode, "url", None)
        elicitation_id = getattr(mode, "elicitation_id", None)
        if requested_schema is None and url is None:
            return schema.DeclineElicitationResponse(action="decline")
        interaction_id = str(elicitation_id or uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._elicitation_futures[interaction_id] = future
        if url is not None:
            await self.updates.put(InternalEvent(
                type="interaction_request",
                data={
                    "interaction_id": interaction_id,
                    "method": "elicitation/create",
                    "mode": "url",
                    "message": str(message),
                    "url": str(url),
                    "elicitation_id": interaction_id,
                    "session_id": getattr(mode, "session_id", None),
                    "tool_call_id": getattr(mode, "tool_call_id", None),
                },
            ))
        else:
            dump = getattr(requested_schema, "model_dump", None)
            schema_data = (
                dump(by_alias=False, exclude_none=True)
                if callable(dump)
                else requested_schema
            )
            await self.updates.put(elicitation_request(
                interaction_id=interaction_id,
                message=str(message),
                requested_schema=schema_data,
                session_id=getattr(mode, "session_id", None),
                tool_call_id=getattr(mode, "tool_call_id", None),
            ))
        try:
            response = await future
        finally:
            self._elicitation_futures.pop(interaction_id, None)
        action = response.get("action")
        if action == "accept":
            content = response.get("content")
            return schema.AcceptElicitationResponse(
                action="accept",
                content=content if isinstance(content, dict) else {},
            )
        if action == "decline":
            return schema.DeclineElicitationResponse(action="decline")
        return schema.CancelElicitationResponse(action="cancel")

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        tool_call_id = getattr(tool_call, "tool_call_id", None) or getattr(tool_call, "id", None)
        if self.needs_approval and tool_call_id is not None:
            # Park the request until the client calls approve_tool(...).
            future = asyncio.get_running_loop().create_future()
            self._approval_futures[tool_call_id] = future
            allow_option = next(
                (option for option in options if option.kind == "allow_once"),
                None,
            )
            self._default_allow_options[tool_call_id] = getattr(
                allow_option, "option_id", None
            )
            self.pending_permissions.append({
                "tool_call_id": tool_call_id,
                "name": getattr(tool_call, "title", "") or "",
                "kind": getattr(tool_call, "kind", None),
                "input": getattr(tool_call, "raw_input", None) or {},
            })
            await self.updates.put(permission_request(
                interaction_id=tool_call_id,
                session_id=str(session_id),
                tool_call={
                    "tool_call_id": tool_call_id,
                    "title": getattr(tool_call, "title", "") or "",
                    "kind": getattr(tool_call, "kind", None),
                    "raw_input": getattr(tool_call, "raw_input", None) or {},
                },
                options=[{
                    "option_id": str(getattr(option, "option_id", "")),
                    "name": str(
                        getattr(option, "name", "")
                        or getattr(option, "kind", "")
                    ),
                    "kind": str(getattr(option, "kind", "")),
                } for option in options],
            ))
            selected_option_id = await future
            self.pending_permissions = [
                pending
                for pending in self.pending_permissions
                if pending.get("tool_call_id") != tool_call_id
            ]
            self._approval_futures.pop(tool_call_id, None)
            self._default_allow_options.pop(tool_call_id, None)
            if not selected_option_id:
                return schema.RequestPermissionResponse(
                    outcome=schema.DeniedOutcome(outcome="cancelled")
                )
            selected = next(
                (
                    option for option in options
                    if option.option_id == selected_option_id
                ),
                None,
            )
            if selected is None or str(selected.kind).startswith("reject"):
                return schema.RequestPermissionResponse(
                    outcome=schema.DeniedOutcome(outcome="cancelled")
                )
            return schema.RequestPermissionResponse(
                outcome=schema.AllowedOutcome(
                    outcome="selected",
                    option_id=selected.option_id,
                )
            )

        tool_kind = getattr(tool_call, "kind", None)
        should_allow = (
            self.permission_mode is None
            or self.permission_mode in {
                "auto",
                "bypassPermissions",
                "workspace-write",
                "danger-full-access",
            }
            or (
                self.permission_mode == "acceptEdits"
                and tool_kind == "edit"
            )
            or (
                self.permission_mode in {"plan", "read-only"}
                and tool_kind in {"read", "search", "think", "fetch"}
            )
        )
        preferred_kinds = (
            ("allow_always", "allow_once")
            if self.permission_mode == "bypassPermissions"
            else ("allow_once", "allow_always")
        ) if should_allow else ("reject_once", "reject_always")
        selected = next(
            (
                option
                for preferred_kind in preferred_kinds
                for option in options
                if option.kind == preferred_kind
            ),
            None,
        )
        if selected is None or not should_allow:
            return schema.RequestPermissionResponse(
                outcome=schema.DeniedOutcome(outcome="cancelled")
            )
        return schema.RequestPermissionResponse(
            outcome=schema.AllowedOutcome(
                outcome="selected",
                option_id=selected.option_id,
            )
        )

    async def write_text_file(self, session_id, path, content, **kwargs):
        raise acp.RequestError.method_not_found("fs/write_text_file")

    async def read_text_file(self, session_id, path, line=None, limit=None, **kwargs):
        raise acp.RequestError.method_not_found("fs/read_text_file")

    async def complete_elicitation(self, elicitation_id: str, **kwargs):
        """Agent 通知 elicitation 已完成（独立于 session/update 通道）。

        进入 session update 队列，由 ``_map_notification`` 翻译为
        ``elicitation_completed`` 事件。
        """
        await self.updates.put(schema.CompleteElicitationNotification(
            elicitation_id=elicitation_id,
        ))

    async def create_terminal(self, session_id, command, **kwargs):
        raise acp.RequestError.method_not_found("terminal/create")

    async def kill_terminal(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/kill")

    async def release_terminal(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/release")

    async def terminal_output(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/output")

    async def wait_for_terminal_exit(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError.method_not_found("terminal/wait_for_exit")

    async def ext_method(self, method: str, params: dict) -> dict:
        raise acp.RequestError.method_not_found(f"_{method}")

    async def ext_notification(self, method: str, params: dict) -> None:
        await self.updates.put(acp_raw_event({
            "method": method,
            "params": params,
        }))

    def on_connect(self, conn) -> None:
        return None


