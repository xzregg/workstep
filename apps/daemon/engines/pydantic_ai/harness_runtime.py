"""Pydantic AI harness capabilities, persistence, and compaction receipts."""

from services.project_storage import data_directory
import asyncio
import logging
from pathlib import Path

from engines.core.events import compacted_event
from services.config import config_store

logger = logging.getLogger(__name__)


class PydanticAIHarnessRuntime:
    """Own harness configuration and session persistence for the engine."""

    async def _prepare_prompt_input(self, kwargs: dict, system_prompt: str | None, *, each_turn: bool = False) -> dict:
        prepared = await super()._prepare_prompt_input(kwargs, system_prompt, each_turn=each_turn)
        instruction = prepared.get("system_prompt")
        if str(kwargs.get("prompt") or "").strip() == "/compact":
            return prepared
        history = await self._harness_continue_history(Path(kwargs["cwd"]), kwargs.get("session_id"))
        from pydantic_ai.messages import ModelRequest, SystemPromptPart

        previous = [
            part.content
            for message in history or [] if isinstance(message, ModelRequest)
            for part in message.parts if isinstance(part, SystemPromptPart)
            and part.dynamic_ref == "workstep.session.instructions"
        ]
        if not instruction and previous:
            prepared["system_prompt"] = ""  # Explicitly clear the saved WorkStep rules.
        elif not each_turn and previous == [instruction]:
            prepared.pop("system_prompt", None)
        return prepared

    @staticmethod
    def _with_session_system_prompt(history: list | None, instruction: str | None) -> list | None:
        """Keep one WorkStep system message; preserve other system messages."""
        if instruction is None:
            return history
        from dataclasses import replace
        from pydantic_ai.messages import ModelRequest, SystemPromptPart

        messages = []
        for message in history or []:
            if isinstance(message, ModelRequest):
                parts = [part for part in message.parts if not (
                    isinstance(part, SystemPromptPart)
                    and part.dynamic_ref == "workstep.session.instructions"
                )]
                if not parts:
                    continue
                message = replace(message, parts=parts)
            messages.append(message)
        if not instruction:
            return messages or None
        return [ModelRequest(parts=[SystemPromptPart(
            content=instruction, dynamic_ref="workstep.session.instructions",
        )]), *messages]

    @staticmethod
    def _retain_session_system_prompt(original: list, compacted: list) -> list:
        from pydantic_ai.messages import ModelRequest, SystemPromptPart

        def rules(messages):
            return [part for message in messages if isinstance(message, ModelRequest)
                    for part in message.parts if isinstance(part, SystemPromptPart)
                    and part.dynamic_ref == "workstep.session.instructions"]
        saved = rules(original)
        if saved and not rules(compacted):
            return [ModelRequest(parts=saved), *compacted]
        return compacted

    # --- pydantic-ai-harness 扩展（上下文压缩 / 会话持久化） ---

    @staticmethod
    def _harness_enabled() -> bool:
        """Whether the harness extension is on (config auto + installed)."""
        config = config_store.get_pydantic_ai_engine_config()
        if str(config.get("harness") or "auto") == "off":
            return False
        try:
            import pydantic_ai_harness  # noqa: F401

            return True
        except Exception:
            return False

    @staticmethod
    def _harness_store(root: Path):
        """SQLite StepPersistence store under the project .workstep dir."""
        from pydantic_ai_harness.step_persistence import SqliteStepStore

        workstep_dir = data_directory(root)
        workstep_dir.mkdir(parents=True, exist_ok=True)
        return SqliteStepStore(
            database=workstep_dir / "harness_runs.db",
            # WorkStep 的会话恢复（continue_run）只读最新一个 complete
            # 快照，从不消费中间 step 回退点；保留多份完整累积历史纯属
            # 磁盘冗余（单 run 曾达 ~130MB）。保留 1 份即可，单 run ~5MB。
            max_snapshots_per_run=1,
        )

    def delete_session_persistence(self, session_id: str, cwd: str) -> None:
        """Drop this conversation's StepPersistence rows from harness_runs.db.

        ``SqliteStepStore`` (fixed dep ``pydantic-ai-harness``) exposes no
        delete API, and WorkStep's ``conversation_id == engine_session_id``,
        so purge the tables by that key directly. tool_effects has no
        conversation_id column, so it is removed via the run ids.
        """
        if not session_id or not self._harness_enabled():
            return
        import sqlite3

        db = data_directory(cwd) / "harness_runs.db"
        if not db.exists():
            return
        try:
            conn = sqlite3.connect(str(db))
            try:
                run_ids = [
                    r[0]
                    for r in conn.execute(
                        "SELECT run_id FROM runs WHERE conversation_id = ?",
                        (session_id,),
                    )
                ]
                if run_ids:
                    ph = ",".join("?" * len(run_ids))
                    conn.execute(
                        f"DELETE FROM tool_effects WHERE run_id IN ({ph})", run_ids
                    )
                for table in ("runs", "events", "snapshots"):
                    conn.execute(
                        f"DELETE FROM {table} WHERE conversation_id = ?",
                        (session_id,),
                    )
                conn.commit()
                conn.execute("VACUUM")
            finally:
                conn.close()
        except Exception:
            logger.exception(
                "Failed to purge harness_runs.db for session %s", session_id
        )

    @classmethod
    def _harness_summary_model(cls):
        """SummarizingCompaction 的摘要模型。

        优先 pydantic_ai_engine.fast_model（config.getter 已回退 coordinator
        快速模型），用当前引擎供应商的 base_url/api_key 构建模型对象；
        未配置快速模型时返回 None（摘要走 run 自身模型）。任何配置异常
        都静默降级为 None，不阻断 harness 挂载。
        """
        try:
            config = config_store.get_pydantic_ai_engine_config()
            fast_model_name = str(config.get("fast_model") or "").strip()
            if not fast_model_name:
                return None
            provider = config_store.get_provider(str(config.get("provider_id") or ""))
            if provider is None:
                return None
            return cls.build_model(provider=provider, model_name=fast_model_name)
        except Exception:
            return None

    @classmethod
    def _harness_capabilities(
        cls,
        root: Path,
        session_id: str | None,
    ) -> list | None:
        """Harness capabilities for this run, or None when disabled."""
        if not cls._harness_enabled() or root is None or not root.is_dir():
            return None
        try:
            from pydantic_ai_harness.compaction import (
                ClearToolResults,
                SlidingWindowCompaction,
                SummarizingCompaction,
                TieredCompaction,
                WarnNearLimits,
            )
            from pydantic_ai_harness.conversation_search import (
                ConversationSearch,
                SnapshotHistorySource,
            )
            from pydantic_ai_harness.step_persistence import StepPersistence
        except Exception:
            return None
        class SessionSlidingWindowCompaction(SlidingWindowCompaction):
            async def compact(self, messages, ctx):
                compacted = await super().compact(messages, ctx)
                return cls._retain_session_system_prompt(messages, compacted)

        # StepPersistence 与 ConversationSearch 共享同一个 SQLite store：
        # 后者通过 SnapshotHistorySource 做 BM25 检索（scope=conversation，
        # 只召回同一 conversation_id 的历史 run）。
        store = cls._harness_store(root)
        return [
            TieredCompaction(
                target_fraction=0.9,
                tiers=[
                    ClearToolResults(max_messages=200, keep_pairs=10),
                    # 零成本层：只收窄请求窗口、不写回持久化历史，原文仍可被
                    # ConversationSearch 检索。TieredCompaction 直接驱动
                    # compact()，max_messages 仅用于满足构造校验（trigger 旁路），
                    # 实际裁剪目标是 keep_messages=60 条尾部。
                    SessionSlidingWindowCompaction(max_messages=200, keep_messages=60),
                    SummarizingCompaction(
                        max_messages=120,
                        keep_messages=30,
                        receipts=True,
                        model=cls._harness_summary_model(),
                    ),
                ],
            ),
            WarnNearLimits(max_context_fraction=0.85),
            StepPersistence(
                store=store,
                agent_name="workstep",
            ),
            ConversationSearch(SnapshotHistorySource(store), scope="conversation"),
        ]

    @classmethod
    async def _harness_continue_history(
        cls,
        root: Path,
        session_id: str | None,
    ) -> list | None:
        """Load the persisted snapshot for this session, when available."""
        if (
            not session_id
            or not await asyncio.to_thread(cls._harness_enabled)
            or root is None
            or not await asyncio.to_thread(root.is_dir)
        ):
            return None
        try:
            from pydantic_ai_harness.step_persistence import continue_run

            store = await asyncio.to_thread(cls._harness_store, root)
            runs = await store.list_runs(conversation_id=session_id)
            # StepPersistence registers the new retry run before WorkStep asks
            # for continuation history. That newest run has no snapshot yet;
            # walk backwards so a failed turn resumes from its last durable
            # step instead of falling back to the previous successful turn.
            for run in reversed(runs):
                if await store.latest_snapshot(run_id=run.run_id) is not None:
                    return list(await continue_run(store, run_id=run.run_id))
            return None
        except Exception:
            return None

    @staticmethod
    def _open_receipt_scope(enabled: bool):
        """Open a compaction-receipt scope for the run (None when disabled)."""
        if not enabled:
            return None
        try:
            from pydantic_ai_harness.compaction._receipts import open_receipt_scope

            return open_receipt_scope()
        except Exception:
            return None

    @staticmethod
    async def _drain_compaction_receipts(scope, on_event) -> None:
        """Emit ``compacted`` events for receipts recorded during the run."""
        if scope is None:
            return
        try:
            from pydantic_ai_harness.compaction._receipts import (
                drain_receipts,
                reset_receipt_scope,
            )

            receipts = []
            try:
                receipts = drain_receipts()
            finally:
                reset_receipt_scope(scope)
            for receipt in receipts:
                await on_event(compacted_event(summary=(
                    f"{receipt.strategy} 压缩：丢弃 {receipt.dropped_messages} "
                    f"条消息、约 {receipt.dropped_tokens} tokens"
                )))
        except Exception:
            logger.exception("Failed to drain compaction receipts")
