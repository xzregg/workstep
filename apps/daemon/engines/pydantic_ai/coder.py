"""WorkStep compatibility layer for the harness Coder capability."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from pydantic_ai import ModelRetry
from pydantic_ai_harness import Coder, FileSystem, Shell
from pydantic_ai_harness.planning import InMemoryPlanStore, Planning
from pydantic_ai_harness.shell import ShellToolset
from pydantic_ai_harness.subagents import SubAgents


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
        subagent_event_handler: Any = None,
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
        # Rebuild the SubAgents capability (if any) with an event-stream handler so
        # sub-agent model/tool events surface into the parent event stream.
        # dataclasses.replace keeps all other fields (agents, models, budgets…).
        if subagent_event_handler is not None:
            import dataclasses

            for index, capability in enumerate(self.capabilities):
                if not isinstance(capability, SubAgents):
                    continue
                replacement = dataclasses.replace(
                    capability,
                    event_stream_handler=subagent_event_handler,
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
            replacement = _dataclasses.replace(
                capability,
                protected_patterns=protected,
            )
            self.capabilities[index] = replacement
            self._instruction_sources = [
                replacement if source is capability else source
                for source in self._instruction_sources
            ]
            break
