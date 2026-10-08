"""Opt-in live API check using the configured DeepSeek Harness provider.

Run: uv run --no-sync --directory apps/daemon python ../../scripts/verify_deepseek_session.py
Uses temporary project/config files; never changes the running daemon or user projects.
"""

import argparse
import asyncio
import copy
import json
import os
import secrets
import sys
import tempfile
from pathlib import Path


async def verify(model_override: str | None, timeout: float) -> None:
    from httpx import ASGITransport, AsyncClient
    import services.config as config
    from engines.deepseek_harness import DeepSeekHarnessEngine

    snapshot = copy.deepcopy(config.config_store._load())
    old_dir, old_file = config.CONFIG_DIR, config.CONFIG_FILE
    old_cache = config.config_store._cache
    manager = module = bus = None
    with tempfile.TemporaryDirectory(prefix="workstep-deepseek-check-") as directory:
        root = Path(directory)
        config.CONFIG_DIR, config.CONFIG_FILE = root, root / "config.json"
        config.config_store._cache = snapshot
        try:
            cfg = config.config_store.get_deepseek_harness_config()
            provider = config.config_store.get_provider(cfg["provider_id"])
            if not provider or not provider.get("api_key"):
                raise RuntimeError("请先配置 DeepSeek Harness 供应商")
            model = model_override or config.config_store.get_engine_default_model(
                "deepseek_harness"
            ) or cfg["model"]
            if not DeepSeekHarnessEngine.is_installed():
                raise RuntimeError("DeepSeek Harness SDK/运行时未安装")

            import main
            from services.project import ProjectManager
            from streaming.bus import EventBus
            from agent_assistants.chat_session import ChatSessionModule

            manager, bus = ProjectManager(), EventBus()
            module = ChatSessionModule(bus, manager)
            project = await asyncio.to_thread(manager.init_project, root / "project")
            main.project_manager, main.chat_session_module = manager, module
            token = "WS-" + secrets.token_hex(8)
            async with AsyncClient(
                transport=ASGITransport(app=main.app), base_url="http://test",
            ) as client:
                async def create(title):
                    response = await client.post("/api/chat-sessions", json={
                        "project_id": project.id, "title": title,
                        "engine": "deepseek_harness", "model": model,
                        "provider_id": provider["id"],
                    })
                    response.raise_for_status()
                    return response.json()["id"]

                async def turn(sid, prompt):
                    response = await client.post(f"/api/chat-sessions/{sid}/chat", json={
                        "project_id": project.id, "content": prompt,
                    }, headers={"Idempotency-Key": secrets.token_hex(12)})
                    response.raise_for_status()
                    message_id = response.json()["assistant_message_id"]
                    deadline = asyncio.get_running_loop().time() + timeout
                    while asyncio.get_running_loop().time() < deadline:
                        health = await asyncio.wait_for(client.get("/api/health"), 1)
                        health.raise_for_status()
                        response = await client.get(f"/api/chat-sessions/{sid}", params={
                            "project_id": project.id,
                        })
                        response.raise_for_status()
                        detail = response.json()
                        message = next(m for m in detail["messages"] if m["id"] == message_id)
                        if message.get("status") in {"succeeded", "error", "stopped"}:
                            if message["status"] != "succeeded":
                                raise AssertionError(f"回合失败：{message.get('content')}")
                            engine_sid = detail["engine_session_id"]
                            assert engine_sid
                            entry = next(iter(DeepSeekHarnessEngine._POOL.values()))
                            pid = entry.harness.client._proc.pid
                            assert not any(
                                e.get("data", {}).get("status") == "session_fallback"
                                for e in message.get("events", [])
                            )
                            print(json.dumps({
                                "session_id": engine_sid, "pid": pid,
                                "answer": message["content"],
                            }, ensure_ascii=False), flush=True)
                            return engine_sid, pid, message["content"]
                        await asyncio.sleep(0.1)
                    raise TimeoutError(f"回合超过 {timeout:g} 秒")

                sid = await create("连续会话测试")
                print(f"provider={provider['name']} model={model}", flush=True)
                first_sid, first_pid, _ = await turn(
                    sid, f"请记住暗号 {token}。只回复“已记住”。不要使用工具。",
                )
                # Force the next turn to restore the engine ID from SQLite.
                module._sessions.clear()
                second_sid, second_pid, answer = await turn(
                    sid, "上条消息的暗号是什么？只输出暗号。不要使用工具。",
                )
                assert token in answer
                assert (second_sid, second_pid) == (first_sid, first_pid)
                other_sid, other_pid, answer = await turn(
                    await create("独立会话测试"),
                    "我之前告诉过你暗号吗？没有则只输出 UNKNOWN。不要使用工具。",
                )
                assert other_sid != first_sid and other_pid == first_pid
                assert token not in answer and "UNKNOWN" in answer
                third_sid, third_pid, answer = await turn(
                    sid, "再次输出本会话第一条消息中的暗号。不要使用工具。",
                )
                assert token in answer
                assert (third_sid, third_pid) == (first_sid, first_pid)
                print("PASS: API 保存/恢复 ID、连续三轮上下文、独立会话隔离、PID 复用、健康检查", flush=True)
        finally:
            if module:
                await module.shutdown()
            if bus:
                await bus.close()
            await asyncio.to_thread(DeepSeekHarnessEngine.shutdown_pool)
            if manager:
                await asyncio.to_thread(manager.close_all)
            config.CONFIG_DIR, config.CONFIG_FILE = old_dir, old_file
            config.config_store._cache = old_cache


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model")
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    daemon = Path(__file__).resolve().parents[1] / "apps" / "daemon"
    sys.path.insert(0, str(daemon))
    packages = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR")
    config_root = Path(os.environ.get("WORKSTEP_CONFIG_DIR", str(Path.home() / ".workstep")))
    sys.path.append(packages or str(config_root / "runtime" / "python-packages"))
    asyncio.run(verify(args.model, args.timeout))
