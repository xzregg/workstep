"""Opt-in real-engine smoke test for automatic context compaction.

This script intentionally does not run as part of the default test suite. It
uses the production engine adapters, grows a resumable conversation until a
``compacted`` event is observed, then checks that the conversation continues.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engines.core.registry import create_engine, refresh_registry

COMPACTION_ENGINES = (
    "codex",
    "claude",
    "codex_sdk",
    "claude_agent_sdk",
    "qoder_sdk",
    "deepseek_harness",
    "pydantic_ai",
    "hermes",
)


def engine_overrides(engine_id: str, codex_limit: int, claude_pct: int) -> dict:
    if engine_id == "codex":
        return {
            "model_auto_compact_token_limit": codex_limit,
            "model_auto_compact_token_limit_scope": "total",
        }
    if engine_id == "claude":
        return {"autocompact_pct_override": claude_pct}
    return {}


async def run_engine(
    engine_id: str,
    *,
    cwd: str,
    turns: int,
    chunk_chars: int,
    timeout: float,
    codex_limit: int,
    claude_pct: int,
) -> dict:
    engine = create_engine(engine_id)
    if engine is None:
        return {"engine": engine_id, "status": "unavailable"}
    if not engine.supports_resume:
        return {"engine": engine_id, "status": "unsupported_resume"}

    marker = f"WORKSTEP_COMPACTION_MARKER_{engine_id.upper()}"
    session_id = None
    event_types: list[str] = []
    compacted = False
    continuation_ok = False
    overrides = engine_overrides(engine_id, codex_limit, claude_pct)

    for turn in range(1, turns + 1):
        prompt = (
            f"Remember this exact marker for later: {marker}. "
            "Reply briefly and do not use tools.\n\n"
            f"Context chunk {turn}: "
            + " ".join(f"fact-{turn}-{index}" for index in range(chunk_chars // 12))
        )
        try:
            events = await _collect_with_timeout(
                engine, prompt, cwd, session_id, overrides, timeout
            )
        except asyncio.TimeoutError:
            return {
                "engine": engine_id,
                "status": "timeout",
                "turn": turn,
                "event_types": event_types,
            }
        event_types.extend(event.type for event in events)
        for event in events:
            if event.type == "session_started":
                session_id = str(event.data.get("session_id") or session_id or "") or None
            if event.type == "usage_update" and event.data.get("session_id"):
                session_id = str(event.data["session_id"])
            compacted = compacted or event.type == "compacted"
        if compacted:
            canary = await _collect_with_timeout(
                engine,
                f"What exact marker did I ask you to remember? Reply only with {marker}.",
                cwd,
                session_id,
                overrides,
                timeout,
            )
            event_types.extend(event.type for event in canary)
            text = "".join(
                str((event.data.get("content") or {}).get("text", ""))
                for event in canary
                if event.type == "agent_message_chunk"
            )
            continuation_ok = marker in text
            break

    return {
        "engine": engine_id,
        "status": "passed" if compacted and continuation_ok else "not_triggered",
        "compacted": compacted,
        "continuation_ok": continuation_ok,
        "session_id": session_id,
        "event_types": event_types,
    }


async def _collect(engine, prompt, cwd, session_id, overrides):
    async for event in engine.spawn_with_retry(
        prompt=prompt,
        cwd=cwd,
        session_id=session_id,
        config_overrides=overrides or None,
    ):
        yield event


async def _collect_with_timeout(engine, prompt, cwd, session_id, overrides, timeout):
    events = []
    async with asyncio.timeout(timeout):
        async for event in _collect(engine, prompt, cwd, session_id, overrides):
            events.append(event)
    return events


async def main(args) -> int:
    refresh_registry()
    requested = args.engine or list(COMPACTION_ENGINES)
    results = []
    for engine_id in requested:
        results.append(await run_engine(
            engine_id,
            cwd=args.cwd,
            turns=args.turns,
            chunk_chars=args.chunk_chars,
            timeout=args.timeout,
            codex_limit=args.codex_limit,
            claude_pct=args.claude_pct,
        ))
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if results and all(item["status"] == "passed" for item in results) else 1


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", action="append", choices=sorted(COMPACTION_ENGINES))
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--turns", type=int, default=20)
    parser.add_argument("--chunk-chars", type=int, default=20000)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--codex-limit", type=int, default=8000)
    parser.add_argument("--claude-pct", type=int, default=5)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(parse_args())))
