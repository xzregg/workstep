"""WorkStep policies on the workspace-based harness Coder."""

import copy
import dataclasses
import sys
from pathlib import Path
from typing import Any, Sequence

from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import LocalWorkspace, WindowsWorkspace
from pydantic_ai_harness import Coder, FileSystem, Shell
from pydantic_ai_harness.file_system import DEFAULT_TOOL_NAMES, FileSystemToolset
from pydantic_ai_harness.planning import InMemoryPlanStore, Planning
from pydantic_ai_harness.shell import ShellToolset
from pydantic_ai_harness.sub_agents import SubAgents


def local_workspace(root: str | Path):
    """Select the native host backend without constructing POSIX on Windows."""
    workspace_type = WindowsWorkspace if sys.platform == "win32" else LocalWorkspace
    return workspace_type(root)


class WorkStepFileSystem(FileSystem):
    """The SDK now delegates disk I/O to its asynchronous workspace backend."""

    toolset_type = FileSystemToolset

    def _file_system_toolset(self):
        if self._toolset is None:
            self._toolset = self.toolset_type(
                root_dir=None if self.root_dir is None else Path(self.root_dir),
                allowed_patterns=self.allowed_patterns,
                denied_patterns=self.denied_patterns,
                read_only_patterns=self.read_only_patterns,
                max_read_lines=self.max_read_lines,
                max_read_chars=self.max_read_chars,
                max_list_results=self.max_list_results,
                max_search_results=self.max_search_results,
                max_find_results=self.max_find_results,
                content_hashes=self.content_hashes,
                tools=self.tools,
                max_retries=self.max_retries,
                id=self.id or "file_system",
            )
        return self._toolset


class ProjectDataToolset(FileSystemToolset):
    """Keep external project artifacts relative to their own bounded backend."""

    async def _scope(self, workspace):
        return await super()._scope(self.data_workspace)


@dataclasses.dataclass
class ProjectDataFileSystem(WorkStepFileSystem):
    toolset_type = ProjectDataToolset

    def _file_system_toolset(self):
        if self._toolset is None:
            toolset = super()._file_system_toolset()
            toolset.data_workspace = local_workspace(self.root_dir)._backend()
        return self._toolset

    def get_toolset(self):
        return super().get_toolset().prefixed("project_data")


class WorkStepShellToolset(ShellToolset):
    """Return command-policy failures without exhausting model tool retries."""

    def _resolve_env(self):
        from services.git.engine_credentials import engine_git_environment

        # Workspace backends inherit only PATH/HOME/locale in SDK 2.69.
        # Keep the host's credential helper, applying the SDK filters as usual.
        resolver = copy.copy(self)
        resolver._env = {**engine_git_environment(), **(self._env or {})}
        return ShellToolset._resolve_env(resolver)

    async def for_run(self, ctx):
        if not self._persist_cwd:
            return self
        toolset = type(self)(
            allowed_commands=self._allowed_commands,
            denied_commands=self._denied_commands,
            denied_operators=self._denied_operators,
            default_timeout=self._default_timeout,
            max_output_chars=self._max_output_chars,
            max_file_bytes=self._max_file_bytes,
            max_log_bytes=self._max_log_bytes,
            persist_cwd=self._persist_cwd,
            allow_interactive=self._allow_interactive,
            env=self._env,
            denied_env_patterns=self._denied_env_patterns,
            tools=self._tools,
            id=self.id,
        )
        toolset.command_policy = getattr(self, "command_policy", None)
        return toolset

    def _check_command(self, command):
        policy = getattr(self, "command_policy", None)
        if policy is None:
            return super()._check_command(command)
        validator = copy.copy(self)
        validator._allowed_commands = policy()
        return ShellToolset._check_command(validator, command)

    async def call_tool(self, name, tool_args, ctx, tool):
        try:
            return await super().call_tool(name, tool_args, ctx, tool)
        except ModelRetry as exc:
            return f"[Command rejected]\n{exc}"


@dataclasses.dataclass
class WorkStepShell(Shell):
    command_policy: Any = None

    def _make_toolset(self):
        toolset = WorkStepShellToolset(
            allowed_commands=self.allowed_commands,
            denied_commands=self.denied_commands,
            denied_operators=self.denied_operators,
            default_timeout=self.default_timeout,
            max_output_chars=self.max_output_chars,
            max_file_bytes=self.max_file_bytes,
            max_log_bytes=self.max_log_bytes,
            persist_cwd=self.persist_cwd,
            allow_interactive=self.allow_interactive,
            env=self.env,
            denied_env_patterns=self.denied_env_patterns,
            tools=self.tools,
            id=self.id or "shell",
        )
        toolset.command_policy = self.command_policy
        return toolset


class WorkStepCoder(Coder):
    """Keep native workspace, shell policy, planning and child-run reporting."""

    def __init__(
        self,
        workspace: str | Path = ".",
        *,
        allowed_commands: Sequence[str] | None = None,
        subagent_capability: Any = None,
        permission_capability: Any = None,
        command_policy: Any = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.plan_store = InMemoryPlanStore()
        additions = [local_workspace(workspace), Planning(store=self.plan_store)]
        from services.conversation_context import execution_env

        replacements = {}
        for capability in self.capabilities:
            replacement = capability
            if isinstance(capability, SubAgents):
                replacement = dataclasses.replace(
                    capability,
                    shared_capabilities=(
                        *capability.shared_capabilities,
                        *(item for item in (subagent_capability, permission_capability) if item is not None),
                    ),
                )
            elif isinstance(capability, Shell):
                replacement = WorkStepShell(
                    command_policy=command_policy,
                    allowed_commands=list(allowed_commands or ()),
                    denied_commands=capability.denied_commands,
                    denied_operators=capability.denied_operators,
                    default_timeout=capability.default_timeout,
                    max_output_chars=capability.max_output_chars,
                    allow_interactive=capability.allow_interactive,
                    env=execution_env(dict(capability.env or {})),
                    denied_env_patterns=capability.denied_env_patterns,
                    # Preserve the existing run/start/check/stop tool protocol.
                    tools=("shell",) if sys.platform == "win32" else (
                        "run_command", "start_command", "check_command", "stop_command",
                    ),
                )
            elif isinstance(capability, FileSystem):
                replacement = WorkStepFileSystem(
                    root_dir=Path(workspace),
                    allowed_patterns=capability.allowed_patterns,
                    denied_patterns=capability.denied_patterns,
                    read_only_patterns=[*capability.read_only_patterns, ".workstep/MEMORY.md"],
                    max_read_lines=capability.max_read_lines,
                    max_read_chars=capability.max_read_chars,
                    max_list_results=capability.max_list_results,
                    max_search_results=capability.max_search_results,
                    max_find_results=capability.max_find_results,
                    read_only=capability.read_only,
                    content_hashes=capability.content_hashes,
                    tools=tuple(dict.fromkeys([*capability.tools, *DEFAULT_TOOL_NAMES])),
                )
            replacements[id(capability)] = replacement
        # Rebuild the composition through its supported initializer so rebinding
        # and instruction sources include replacements and added capabilities.
        from pydantic_ai.capabilities import CombinedCapability
        CombinedCapability.__init__(self, [
            *additions,
            *(replacements[id(capability)] for capability in self.capabilities),
        ])
