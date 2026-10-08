"""WorkStep compatibility layer for the harness Coder capability."""

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import anyio
from pydantic_ai import ModelRetry
from pydantic_ai_harness import Coder, FileSystem, Shell
from pydantic_ai_harness.filesystem import (
    READ_ONLY_TOOL_NAMES,
    FileSystemToolset,
)
from pydantic_ai_harness.planning import InMemoryPlanStore, Planning
from pydantic_ai_harness.shell import ShellToolset
from pydantic_ai_harness.subagents import SubAgents
from pydantic_ai.toolsets import FilteredToolset


class WorkStepFileSystemToolset(FileSystemToolset):
    """Run the harness's synchronous filesystem implementation in a worker."""

    @staticmethod
    async def _offload(operation, /, *args, **kwargs):
        def run():
            return asyncio.run(operation(*args, **kwargs))

        return await asyncio.to_thread(run)

    async def read_file(self, path: str, *, offset: int = 0, limit: int | None = None) -> str:
        return await self._offload(super().read_file, path, offset=offset, limit=limit)

    async def write_file(self, path: str, content: str, *, expected_hash: str | None = None) -> str:
        return await self._offload(super().write_file, path, content, expected_hash=expected_hash)

    async def edit_file(
        self,
        path: str,
        old_text: str,
        new_text: str,
        *,
        expected_hash: str | None = None,
    ) -> str:
        return await self._offload(
            super().edit_file,
            path,
            old_text,
            new_text,
            expected_hash=expected_hash,
        )

    async def list_directory(self, path: str = ".") -> str:
        return await self._offload(super().list_directory, path)

    async def search_files(
        self,
        pattern: str,
        *,
        path: str = ".",
        include_glob: str | None = None,
    ) -> str:
        return await self._offload(
            super().search_files,
            pattern,
            path=path,
            include_glob=include_glob,
        )

    async def find_files(self, pattern: str, *, path: str = ".") -> str:
        return await self._offload(super().find_files, pattern, path=path)

    async def create_directory(self, path: str) -> str:
        return await self._offload(super().create_directory, path)

    async def file_info(self, path: str) -> str:
        return await self._offload(super().file_info, path)


@dataclass
class WorkStepFileSystem(FileSystem):
    """Harness filesystem capability whose disk work cannot stall FastAPI."""

    def get_toolset(self):
        toolset = WorkStepFileSystemToolset(
            root_dir=Path(self.root_dir),
            allowed_patterns=self.allowed_patterns,
            denied_patterns=self.denied_patterns,
            protected_patterns=self.protected_patterns,
            max_read_lines=self.max_read_lines,
            max_list_results=self.max_list_results,
            max_search_results=self.max_search_results,
            max_find_results=self.max_find_results,
        )
        if self.read_only:
            return FilteredToolset(
                toolset,
                lambda ctx, tool: tool.name in READ_ONLY_TOOL_NAMES,
            )
        return toolset


@dataclass
class ProjectDataFileSystem(WorkStepFileSystem):
    """Dedicated tools for an external project's data, without widening code root."""

    def get_toolset(self):
        return super().get_toolset().prefixed("project_data")


class WorkStepShellToolset(ShellToolset):
    """Return command-policy failures to the model without spending retries."""

    async def for_run(self, ctx):
        return WorkStepShellToolset(
            cwd=self._initial_cwd,
            allowed_commands=self._allowed_commands,
            denied_commands=self._denied_commands,
            denied_operators=self._denied_operators,
            default_timeout=self._default_timeout,
            max_output_chars=self._max_output_chars,
            persist_cwd=self._persist_cwd,
            allow_interactive=self._allow_interactive,
            env=self._env,
            denied_env_patterns=self._denied_env_patterns,
        )

    async def call_tool(self, name, tool_args, ctx, tool):
        try:
            return await super().call_tool(name, tool_args, ctx, tool)
        except ModelRetry as exc:
            # The harness Shell uses ModelRetry for correctable command-policy
            # failures. Pydantic AI counts those globally per tool name, so a
            # few different rejected commands can otherwise abort the entire
            # coding turn. Keep the rejection visible while allowing the model
            # to choose another command.
            return f"[Command rejected]\n{exc}"

    @staticmethod
    def _background_output(stdout: str, stderr: str, status: str, exit_code=None) -> str:
        sections = []
        if stdout:
            sections.append(f"[stdout]\n{stdout}")
        if stderr:
            sections.append(f"[stderr]\n{stderr}")
        parts = ["\n".join(sections) if sections else "(no output yet)", f"[{status}]"]
        if exit_code is not None:
            parts.append(f"[exit code: {exit_code}]")
        return "\n".join(parts)

    async def check_command(self, command_id: str) -> str:
        bg = self._background.get(command_id)
        if bg is None:
            return f"[Error: unknown command ID {command_id!r}]"
        if not bg.finished and bg.proc.returncode is not None:
            bg.exit_code = bg.proc.returncode
            bg.finished = True
        stdout, stderr = await asyncio.to_thread(self._read_bg_output, bg)
        status = "status: finished" if bg.finished else "status: running"
        return self._background_output(stdout, stderr, status, bg.exit_code if bg.finished else None)

    async def stop_command(self, command_id: str) -> str:
        bg = self._background.get(command_id)
        if bg is None:
            return f"[Error: unknown command ID {command_id!r}]"
        if not bg.finished:
            await self._kill_process_group(bg.proc)
            with anyio.CancelScope(shield=True):
                await bg.proc.wait()
            bg.exit_code = bg.proc.returncode
            bg.finished = True
        stdout, stderr = await asyncio.to_thread(self._read_bg_output, bg)
        await asyncio.to_thread(self._cleanup_bg_files, bg)
        del self._background[command_id]
        await bg.proc.aclose()
        return self._background_output(stdout, stderr, "stopped", bg.exit_code)


@dataclass
class WorkStepShell(Shell):
    """Harness Shell using WorkStep's non-fatal policy-error behavior."""

    def get_toolset(self) -> WorkStepShellToolset:
        return WorkStepShellToolset(
            cwd=Path(self.cwd),
            allowed_commands=self.allowed_commands,
            denied_commands=self.denied_commands,
            denied_operators=self.denied_operators,
            default_timeout=self.default_timeout,
            max_output_chars=self.max_output_chars,
            persist_cwd=self.persist_cwd,
            allow_interactive=self.allow_interactive,
            env=self.env,
            denied_env_patterns=self.denied_env_patterns,
        )


class WorkStepCoder(Coder):
    """Harness Coder with command rejections represented as tool output."""

    def __init__(
        self,
        workspace: str | Path = ".",
        *,
        allowed_commands: Sequence[str] | None = None,
        subagent_capability: Any = None,
        **kwargs,
    ) -> None:
        super().__init__(
            workspace,
            allowed_commands=allowed_commands,
            **kwargs,
        )
        # Pin the Planning capability to an explicit store so the host engine can
        # read the authoritative plan state (the capability otherwise creates an
        # opaque per-run store). ``plan_store`` is exposed for that purpose.
        self.plan_store: Any = None
        import dataclasses as _dataclasses

        for index, capability in enumerate(self.capabilities):
            if not isinstance(capability, Planning):
                continue
            replacement = capability
            if capability.store is None and capability.store_resolver is None:
                store = InMemoryPlanStore()
                replacement = _dataclasses.replace(capability, store=store)
            else:
                store = capability.store
            self.plan_store = store
            if replacement is not capability:
                self.capabilities[index] = replacement
                self._instruction_sources = [
                    replacement if source is capability else source
                    for source in self._instruction_sources
                ]
            break
        # Rebuild SubAgents with a capability observing complete child runs so
        # sub-agent model/tool events surface into the parent event stream.
        # dataclasses.replace keeps all other fields (agents, models, budgets…).
        if subagent_capability is not None:
            import dataclasses

            for index, capability in enumerate(self.capabilities):
                if not isinstance(capability, SubAgents):
                    continue
                replacement = dataclasses.replace(
                    capability,
                    shared_capabilities=(*capability.shared_capabilities, subagent_capability),
                )
                self.capabilities[index] = replacement
                # Keep the composition view aligned so _rebound() can rebind by
                # object identity; otherwise the old instance dangles and
                # CombinedCapability._rebound asserts on a non-combined source.
                self._instruction_sources = [
                    replacement if source is capability else source
                    for source in self._instruction_sources
                ]
                break
        for index, capability in enumerate(self.capabilities):
            if not isinstance(capability, Shell):
                continue
            replacement = WorkStepShell(
                cwd=capability.cwd,
                allowed_commands=capability.allowed_commands,
                denied_commands=capability.denied_commands,
                denied_operators=capability.denied_operators,
                default_timeout=capability.default_timeout,
                max_output_chars=capability.max_output_chars,
                persist_cwd=capability.persist_cwd,
                allow_interactive=capability.allow_interactive,
                env=capability.env,
                denied_env_patterns=capability.denied_env_patterns,
            )
            self.capabilities[index] = replacement
            self._instruction_sources = [
                replacement if source is capability else source
                for source in self._instruction_sources
            ]
            break
        # Protect project memory from model writes: MEMORY.md is injected into
        # the prompt upstream (services.prompt) and must stay read-only to the
        # coding agent. The pattern is relative to the FileSystem root.
        for index, capability in enumerate(self.capabilities):
            if not isinstance(capability, FileSystem):
                continue
            protected = list(capability.protected_patterns)
            if ".workstep/MEMORY.md" not in protected:
                protected.append(".workstep/MEMORY.md")
            replacement = WorkStepFileSystem(
                root_dir=capability.root_dir,
                allowed_patterns=capability.allowed_patterns,
                denied_patterns=capability.denied_patterns,
                protected_patterns=protected,
                max_read_lines=capability.max_read_lines,
                max_list_results=capability.max_list_results,
                max_search_results=capability.max_search_results,
                max_find_results=capability.max_find_results,
                read_only=capability.read_only,
            )
            self.capabilities[index] = replacement
            self._instruction_sources = [
                replacement if source is capability else source
                for source in self._instruction_sources
            ]
            break
