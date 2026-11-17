"""Enforce WorkStep consent before Harness or registered tools execute."""

from pydantic_ai.capabilities import AbstractCapability


# These tools read data or maintain the in-memory plan, never run host commands.
READ_ONLY_TOOLS = frozenset({
    "read_file", "list_directory", "search_files", "find_files", "file_info",
    "read_plan", "read_plan_tree", "get_available_tasks",
    "write_plan", "add_task", "update_task_status",
    "update_task_statuses", "remove_task", "add_subtask", "set_dependency",
    "ask_user", "update_plan", "list_tools", "web_search", "web_fetch",
})


class ToolPermissions(AbstractCapability):
    def __init__(self, engine, on_event):
        self.engine = engine
        self.on_event = on_event

    async def wrap_tool_execute(self, ctx, *, call, tool_def, args, handler):
        name = call.tool_name
        base_name = name.removeprefix("project_data_")
        if base_name in READ_ONLY_TOOLS:
            return await handler(args)
        # Connector calls already request consent using their connector/tool ID.
        if name == "call_tool":
            return await handler(args)
        if self.engine.tools_read_only():
            return "[Permission denied] read-only mode does not permit this tool."
        native = self.engine.native_permission_mode()
        if native is not None and name != "workstep_call":
            return await handler(args)
        if native is not None and native != "full":
            allowed = await self.engine._request_permission(
                self.on_event, tool_name=name, title=name, kind="other",
                tool_input=call.args_as_dict(),
            )
            return await handler(args) if allowed else "[Permission denied] The user denied this tool call."
        if self.engine.runtime_permission_mode() == "ask":
            allowed = await self.engine._request_permission(
                self.on_event, tool_name=name, title=name,
                kind="execute" if "command" in name or name == "shell" else "other",
                tool_input=call.args_as_dict(),
            )
            if not allowed:
                return "[Permission denied] The user denied this tool call."
        return await handler(args)
