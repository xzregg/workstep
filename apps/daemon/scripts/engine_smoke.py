"""Run one installed WorkStep engine through its production adapter."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engines.registry import create_engine, refresh_registry


async def run(
    engine_id: str,
    cwd: str,
    prompt: str,
    timeout: float,
    expected: str | None,
) -> int:
    refresh_registry()
    engine = create_engine(engine_id)
    if engine is None:
        print(json.dumps({"engine": engine_id, "status": "unavailable"}))
        return 2

    events = []

    async def collect():
        async for event in engine.spawn(prompt=prompt, cwd=cwd):
            events.append(event.to_dict())

    try:
        await asyncio.wait_for(collect(), timeout=timeout)
    except asyncio.TimeoutError:
        await engine.stop()
        print(json.dumps({"engine": engine_id, "status": "timeout"}))
        return 3

    errors = [event for event in events if event["type"] == "error"]
    text = "".join(
        event["data"].get("delta", "")
        for event in events
        if event["type"] == "text_delta"
    )
    passed = not errors and bool(text) and (
        expected is None or expected in text
    )
    result = {
        "engine": engine_id,
        "status": "passed" if passed else "failed",
        "event_types": [event["type"] for event in events],
        "text": text,
        "errors": [event["data"] for event in errors],
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", default="claude")
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument(
        "--prompt",
        default="Reply exactly WORKSTEP_SMOKE_OK. Do not use tools or modify files.",
    )
    parser.add_argument("--expect", default="WORKSTEP_SMOKE_OK")
    args = parser.parse_args()
    return asyncio.run(
        run(args.engine, args.cwd, args.prompt, args.timeout, args.expect)
    )


if __name__ == "__main__":
    raise SystemExit(main())
