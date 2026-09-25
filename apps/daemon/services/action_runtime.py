"""Run configured quick-button scripts without invoking an LLM."""

from __future__ import annotations

import asyncio
import codecs
import json
import os
import signal
import sys
import uuid
from pathlib import Path

import peewee

from models import ActionRun, ChatMessage, ChatSession, Message, ProjectSetting, Task, Workflow
from models.base import db_proxy
from models.fields import utc_now
from services.messages import create_task_message
from services.quick_buttons import valid_script_path


ACTIVE = {"preparing", "running", "stopping"}


class ActionError(ValueError):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _action_input(button: dict, value: str) -> str:
    value = str(value or "")
    if len(value) > 4000:
        raise ActionError("Action 输入内容不能超过 4000 字", 422)
    if button.get("require_confirmation") is not False and button.get("confirmation_input_prompt") and not value.strip():
        raise ActionError("请填写 Action 执行内容", 422)
    return value


def _within(path: Path, root: Path) -> bool:
    return path == root or path.is_relative_to(root)


def _buttons_from_setting(project_id: str) -> list[dict]:
    from agent_assistants.chat_session import DEFAULT_QUICK_BUTTONS

    row = ProjectSetting.get_or_none(
        (ProjectSetting.project_id == project_id)
        & (ProjectSetting.key == "chat_quick_buttons")
    )
    if row is None:
        return [dict(button) for button in DEFAULT_QUICK_BUTTONS]
    try:
        value = json.loads(row.value_json)
        return value if isinstance(value, list) else [dict(button) for button in DEFAULT_QUICK_BUTTONS]
    except (ValueError, TypeError):
        return [dict(button) for button in DEFAULT_QUICK_BUTTONS]


def _workflow_steps(task: Task) -> dict:
    workflow = Workflow.get_or_none(Workflow.id == task.workflow_id)
    if workflow is None:
        return {}
    try:
        value = json.loads(workflow.steps_json)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def _available_buttons(project_id: str, task: Task, step_key: str | None) -> list[dict]:
    steps = _workflow_steps(task)
    local = []
    for node in steps.get("nodes", steps.get("steps", [])):
        if node.get("key", node.get("type", node.get("id"))) == step_key:
            local = [
                {**button, "source": "stage", "step_key": step_key}
                for button in node.get("quickButtons", [])
                if isinstance(button, dict)
            ]
            break
    workflow_buttons = [
        {**button, "source": "workflow"}
        for button in steps.get("quickButtons", [])
        if isinstance(button, dict)
    ]
    inherited = []
    selected_ids = steps.get("projectQuickButtonIds")
    if isinstance(selected_ids, list) or steps.get("inheritProjectQuickButtons") is True:
        inherited = [
            {**button, "source": "project"}
            for button in _buttons_from_setting(project_id)
            if isinstance(button, dict) and (
                not isinstance(selected_ids, list) or button.get("id") in selected_ids
            )
        ]
    return local + workflow_buttons + inherited


def _serialize(run: ActionRun) -> dict:
    return {
        "run_id": run.id,
        "project_id": run.project_id,
        "task_id": run.task_id,
        "session_id": run.session_id,
        "workflow_id": run.workflow_id,
        "step_key": run.step_key,
        "action_id": run.action_id,
        "button_id": run.button_id,
        "source": run.source,
        "title": run.title,
        "script_path": run.script_path,
        "cwd": run.cwd,
        "status": run.status,
        "output": run.output,
        "exit_code": run.exit_code,
        "user_message_id": run.user_message_id,
        "reply_message_id": run.reply_message_id,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
    }


def _script_config(project: Path, task: Task | None, button: dict, source: str) -> dict:
    action_id = str(button.get("action_id") or "")
    script_path = str(button.get("script_path") or "")
    if not valid_script_path(script_path):
        raise ActionError("脚本路径无效")
    project = project.resolve()
    workstep = (project / ".workstep").resolve()
    if not _within(workstep, project):
        raise ActionError("Action 目录超出项目根目录")
    workflow_root = workstep / "artifacts" / (task.workflow_id or "default") if task else None
    task_root = workflow_root / task.id if task else None
    action_root = (
        workstep / "actions" / action_id
        if source == "project"
        else workflow_root / "actions" / action_id
    ).resolve()
    if not _within(action_root, workstep):
        raise ActionError("Action 目录超出项目根目录")
    script = (action_root / script_path).resolve()
    if not _within(script, action_root) or not script.is_file():
        raise ActionError("脚本路径无效或文件不存在")
    cwd_mode = button.get("cwd_mode") or "task"
    cwd = project if task is None or cwd_mode == "project" else task_root
    cwd = cwd.resolve()
    if not _within(cwd, project):
        raise ActionError("执行目录超出项目根目录")
    metadata_path = action_root / "action.json"
    metadata = {}
    if metadata_path.is_file():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ActionError("Action 配置文件无效") from exc
        if not isinstance(metadata, dict) or metadata.get("id", action_id) != action_id:
            raise ActionError("Action 配置文件无效")
    timeout = metadata.get("timeout_seconds", 600)
    grace = metadata.get("stop_grace_seconds", 3)
    managed_service = metadata.get("managed_service") is True
    if not isinstance(timeout, (int, float)) or not (1 <= timeout <= 86400 or (managed_service and timeout == 0)):
        raise ActionError("Action 超时时间无效")
    if not isinstance(grace, (int, float)) or not 0.1 <= grace <= 30:
        raise ActionError("Action 停止宽限期无效")
    interpreter = metadata.get("interpreter")
    if interpreter not in {None, "bash", "python", "executable"}:
        raise ActionError("Action 解释器无效")
    args = metadata.get("args", [])
    if not isinstance(args, list) or len(args) > 32 or any(
        not isinstance(item, str) or "\x00" in item for item in args
    ):
        raise ActionError("Action 参数无效")
    if interpreter == "bash" or (interpreter is None and script.suffix in {".sh", ".bash"}):
        command = ["/bin/bash", str(script), *args]
    elif interpreter == "python" or (interpreter is None and script.suffix == ".py"):
        command = [sys.executable, str(script), *args]
    else:
        if not os.access(script, os.X_OK):
            raise ActionError("脚本没有执行权限")
        command = [str(script), *args]
    return {
        "script": script,
        "project_root": project,
        "action_root": action_root,
        "workflow_root": workflow_root,
        "task_root": task_root,
        "cwd": cwd,
        "command": command,
        "timeout": float(timeout),
        "grace": float(grace),
        "managed_service": managed_service,
    }


class ActionRuntime:
    def __init__(self):
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.stopping: set[str] = set()

    async def shutdown(self) -> None:
        """Stop managed process groups before the project databases close."""
        active = list(self.processes.items())
        self.stopping.update(run_id for run_id, _ in active)
        await asyncio.gather(
            *(self._terminate(proc, 3) for _, proc in active),
            return_exceptions=True,
        )
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)

    @staticmethod
    def _manager():
        from main import project_manager
        return project_manager

    @staticmethod
    def _bus():
        from main import event_bus
        return event_bus

    async def _db(self, project_id: str, operation):
        return await self._manager().run_db(project_id, operation)

    async def list_task(self, project_id: str, task_id: str, step_key: str | None = None) -> dict:
        def load(_project):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ActionError("任务不存在", 404)
            runs = list(ActionRun.select().where(ActionRun.task_id == task_id).order_by(ActionRun.started_at.desc()).limit(50))
            return {"buttons": _available_buttons(project_id, task, step_key), "runs": [_serialize(run) for run in runs]}
        result = await self._db(project_id, load)
        for run in result["runs"]:
            if run["status"] in ACTIVE and run["run_id"] not in self.tasks:
                await self._finish(project_id, run["run_id"], "interrupted", None)
                run["status"] = "interrupted"
        return result

    async def list_session(self, project_id: str, session_id: str) -> dict:
        def load(_project):
            session = ChatSession.get_or_none(
                (ChatSession.id == session_id) & (ChatSession.project_id == project_id)
            )
            if session is None:
                raise ActionError("聊天会话不存在", 404)
            runs = list(ActionRun.select().where(ActionRun.session_id == session_id).order_by(ActionRun.started_at.desc()).limit(50))
            active = list(ActionRun.select().where(
                (ActionRun.project_id == project_id)
                & ActionRun.active_key.startswith(f"project:{project_id}:action:")
            ))
            return {
                "buttons": _buttons_from_setting(project_id),
                "runs": [_serialize(run) for run in runs],
                "active_runs": [_serialize(run) for run in active],
            }
        result = await self._db(project_id, load)
        for run in result["active_runs"]:
            if run["status"] in ACTIVE and run["run_id"] not in self.tasks:
                await self._finish(project_id, run["run_id"], "interrupted", None)
                run["status"] = "interrupted"
        result["active_action_ids"] = [run["action_id"] for run in result.pop("active_runs") if run["status"] in ACTIVE]
        for run in result["runs"]:
            if run["status"] in ACTIVE and run["run_id"] not in self.tasks:
                run["status"] = "interrupted"
        return result

    async def get(self, project_id: str, run_id: str) -> dict:
        def load(_project):
            run = ActionRun.get_or_none(ActionRun.id == run_id)
            if run is None or run.project_id != project_id:
                raise ActionError("Action 运行记录不存在", 404)
            return _serialize(run)
        result = await self._db(project_id, load)
        if result["status"] in ACTIVE and run_id not in self.tasks:
            await self._finish(project_id, run_id, "interrupted", None)
            result = await self._db(project_id, load)
        return result

    async def start(self, project_id: str, task_id: str, button_id: str, source: str, step_key: str | None, confirmed: bool, action_input: str = "") -> dict:
        project = self._manager().get_project_by_id(project_id)
        if project is None:
            raise ActionError("项目不存在", 404)
        if source not in {"project", "workflow", "stage"}:
            raise ActionError("快捷按钮来源无效")

        def claim(_project):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ActionError("任务不存在", 404)
            button = next((item for item in _available_buttons(project_id, task, step_key)
                           if item.get("id") == button_id and item.get("source") == source), None)
            if button is None or button.get("kind") != "action":
                raise ActionError("Action 快捷按钮不存在", 404)
            if button.get("require_confirmation", True) and not confirmed:
                raise ActionError("需要用户确认后执行", 409)
            input_value = _action_input(button, action_input)
            active_key = f"task:{task_id}:action:{button['action_id']}"
            existing = ActionRun.get_or_none(ActionRun.active_key == active_key)
            if existing is not None:
                return _serialize(existing), None
            config = _script_config(Path(project.path), task, button, source)
            config["action_input"] = input_value
            run_id = str(uuid.uuid4())
            now = utc_now()
            with db_proxy.atomic():
                try:
                    run = ActionRun.create(
                        id=run_id, project_id=project_id, task_id=task_id,
                        workflow_id=task.workflow_id, step_key=step_key,
                        action_id=button["action_id"], button_id=button_id, source=source,
                        title=button["label"], script_path=button["script_path"],
                        cwd=str(config["cwd"]), status="preparing", active_key=active_key,
                        user_message_id=str(uuid.uuid4()), reply_message_id=str(uuid.uuid4()),
                        started_at=now,
                    )
                except peewee.IntegrityError:
                    return _serialize(ActionRun.get(ActionRun.active_key == active_key)), None
                create_task_message(
                    id=run.user_message_id, task=task, channel="action", step_key=step_key or "action",
                    role="user", content=f"执行快捷动作：{button['label']}",
                    run_id=run_id, run_status="succeeded", position=0, started_at=now, ended_at=now,
                    created_at=now,
                )
                create_task_message(
                    id=run.reply_message_id, task=task, channel="action", step_key=step_key or "action",
                    role="assistant", content="", reply_to_message_id=run.user_message_id,
                    run_id=run_id, run_status="running", position=1, started_at=now,
                    created_at=now,
                )
            return _serialize(run), config

        result, config = await self._db(project_id, claim)
        if config is None:
            return {**result, "deduplicated": True}
        worker = asyncio.create_task(self._execute(project_id, result, config))
        self.tasks[result["run_id"]] = worker
        worker.add_done_callback(lambda _: self.tasks.pop(result["run_id"], None))
        await self._bus().publish({"type": "action_run_started", "project_id": project_id, "task_id": task_id, **result})
        return {**result, "deduplicated": False}

    async def start_session(self, project_id: str, session_id: str, button_id: str, confirmed: bool, action_input: str = "") -> dict:
        project = self._manager().get_project_by_id(project_id)
        if project is None:
            raise ActionError("项目不存在", 404)

        def claim(_project):
            session = ChatSession.get_or_none(
                (ChatSession.id == session_id) & (ChatSession.project_id == project_id)
            )
            if session is None:
                raise ActionError("聊天会话不存在", 404)
            button = next((item for item in _buttons_from_setting(project_id)
                           if item.get("id") == button_id and item.get("kind") == "action"), None)
            if button is None:
                raise ActionError("Action 快捷按钮不存在", 404)
            if button.get("require_confirmation", True) and not confirmed:
                raise ActionError("需要用户确认后执行", 409)
            input_value = _action_input(button, action_input)
            active_key = f"project:{project_id}:action:{button['action_id']}"
            existing = ActionRun.get_or_none(ActionRun.active_key == active_key)
            if existing is not None:
                return _serialize(existing), None
            config = _script_config(Path(project.path), None, button, "project")
            config["action_input"] = input_value
            run_id = str(uuid.uuid4())
            now = utc_now()
            with db_proxy.atomic():
                try:
                    run = ActionRun.create(
                        id=run_id, project_id=project_id, session_id=session_id,
                        action_id=button["action_id"], button_id=button_id, source="project",
                        title=button["label"], script_path=button["script_path"],
                        cwd=str(config["cwd"]), status="preparing", active_key=active_key,
                        user_message_id=str(uuid.uuid4()), reply_message_id=str(uuid.uuid4()),
                        started_at=now,
                    )
                except peewee.IntegrityError:
                    return _serialize(ActionRun.get(ActionRun.active_key == active_key)), None
                ChatMessage.create(
                    id=run.user_message_id, session=session, role="user",
                    content=f"执行快捷动作：{button['label']}", status="completed",
                    engine="action", created_at=now, ended_at=now,
                )
                ChatMessage.create(
                    id=run.reply_message_id, session=session, role="assistant",
                    content="", status="action_running", engine="action", created_at=now,
                )
            return _serialize(run), config

        result, config = await self._db(project_id, claim)
        if config is None:
            return {**result, "deduplicated": True}
        worker = asyncio.create_task(self._execute(project_id, result, config))
        self.tasks[result["run_id"]] = worker
        worker.add_done_callback(lambda _: self.tasks.pop(result["run_id"], None))
        await self._bus().publish({"type": "action_run_started", "project_id": project_id, **result})
        return {**result, "deduplicated": False}

    async def _update(self, project_id: str, run_id: str, *, output: str | None = None, status: str | None = None):
        def update(_project):
            run = ActionRun.get_by_id(run_id)
            if output is not None:
                run.output = (run.output + output)[-100000:]
                if run.session_id:
                    ChatMessage.update(content=run.output).where(ChatMessage.id == run.reply_message_id).execute()
                else:
                    Message.update(content=run.output).where(Message.id == run.reply_message_id).execute()
            if status is not None:
                may_transition = run.active_key is not None and (
                    status != "running" or run.status == "preparing"
                )
                if may_transition:
                    run.status = status
                    if run.session_id:
                        ChatMessage.update(status=f"action_{status}").where(ChatMessage.id == run.reply_message_id).execute()
                    else:
                        Message.update(run_status=status).where(Message.id == run.reply_message_id).execute()
            run.save()
            return _serialize(run)
        return await self._db(project_id, update)

    async def _finish(self, project_id: str, run_id: str, status: str, exit_code: int | None):
        def finish(_project):
            run = ActionRun.get_by_id(run_id)
            if run.active_key is None:
                return _serialize(run)
            run.status = status
            run.exit_code = exit_code
            run.active_key = None
            run.ended_at = utc_now()
            run.save()
            if run.session_id:
                ChatMessage.update(status=f"action_{status}", ended_at=run.ended_at).where(ChatMessage.id == run.reply_message_id).execute()
            else:
                Message.update(run_status=status, ended_at=run.ended_at).where(Message.id == run.reply_message_id).execute()
            return _serialize(run)
        result = await self._db(project_id, finish)
        await self._bus().publish({"type": f"action_run_{status}", "project_id": project_id, **result})
        return result

    async def _execute(self, project_id: str, run: dict, config: dict):
        run_id = run["run_id"]
        proc = None
        parent_watcher = None
        try:
            if config["task_root"] is not None:
                await asyncio.to_thread(config["task_root"].mkdir, parents=True, exist_ok=True)
                run_dir = config["task_root"] / ".action-runs" / run_id
                worktrees_file = config["task_root"] / ".worktrees.json"
            else:
                run_dir = config["project_root"] / ".workstep" / "action-runs" / run_id
                worktrees_file = run_dir / ".worktrees.json"
            if not _within(await asyncio.to_thread(run_dir.resolve), config["project_root"]):
                raise ActionError("Action 运行目录超出项目根目录")
            await asyncio.to_thread(run_dir.mkdir, parents=True, exist_ok=True)
            if not _within(await asyncio.to_thread(worktrees_file.resolve), config["project_root"]):
                raise ActionError("Worktree 映射文件超出项目根目录")
            worktrees = {"worktrees": []}
            if run["task_id"]:
                from services.git import git_service
                from services.git.task_workspace import TaskGitWorkspace
                worktrees = await TaskGitWorkspace(git_service, run["workflow_id"]).list(config["project_root"], run["task_id"])
            mapping = {"worktrees": [{key: tree.get(key) for key in ("repository_id", "repository_name", "alias", "branch", "path", "relative_path")}
                                     for tree in worktrees.get("worktrees", [])]}
            await asyncio.to_thread(worktrees_file.write_text, json.dumps(mapping, ensure_ascii=False, indent=2), "utf-8")
            env = os.environ.copy()
            env.update({
                "WORKSTEP_PROJECT_ROOT": str(config["project_root"]),
                "WORKSTEP_WORKFLOW_ROOT": str(config["workflow_root"] or ""),
                "WORKSTEP_TASK_ROOT": str(config["task_root"] or ""),
                "WORKSTEP_ACTION_ROOT": str(config["action_root"]),
                "WORKSTEP_WORKTREES_FILE": str(worktrees_file),
                "WORKSTEP_PROJECT_ID": project_id,
                "WORKSTEP_WORKFLOW_ID": run["workflow_id"] or "",
                "WORKSTEP_TASK_ID": run["task_id"] or "",
                "WORKSTEP_STEP_KEY": run["step_key"] or "",
                "WORKSTEP_ACTION_RUN_ID": run_id,
                "WORKSTEP_ACTION_INPUT": config.get("action_input", ""),
            })
            proc = await asyncio.create_subprocess_exec(
                *config["command"], cwd=str(config["cwd"]), env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
            self.processes[run_id] = proc
            if config.get("managed_service"):
                async def stop_orphaned_children():
                    # asyncio Process.wait() can wait for inherited stdout pipes
                    # to close, even after the direct child has exited.
                    while proc.returncode is None:
                        await asyncio.sleep(0.05)
                    # A script that backgrounds servers and exits must not leave
                    # services detached from this Action's stop control.
                    await self._terminate(proc, config["grace"])
                parent_watcher = asyncio.create_task(stop_orphaned_children())
            if run_id in self.stopping:
                await self._terminate(proc, config["grace"])
            else:
                await self._update(project_id, run_id, status="running")
            log_file = run_dir / "output.log"
            decoder = codecs.getincrementaldecoder("utf-8")("replace")

            async def read_output():
                while chunk := await proc.stdout.read(4096):
                    value = decoder.decode(chunk)
                    if value:
                        await asyncio.to_thread(_append_log, log_file, value)
                        await self._update(project_id, run_id, output=value)
                        await self._bus().publish({"type": "action_run_output", "project_id": project_id, "task_id": run["task_id"], "session_id": run["session_id"], "run_id": run_id, "output": value})
                tail = decoder.decode(b"", final=True)
                if tail:
                    await asyncio.to_thread(_append_log, log_file, tail)
                    await self._update(project_id, run_id, output=tail)
                return await proc.wait()

            try:
                exit_code = (
                    await read_output() if config["timeout"] == 0
                    else await asyncio.wait_for(read_output(), timeout=config["timeout"])
                )
                status = "stopped" if run_id in self.stopping else "succeeded" if exit_code == 0 else "failed"
            except asyncio.TimeoutError:
                await self._terminate(proc, config["grace"])
                exit_code = await proc.wait()
                status = "timed_out"
            await self._finish(project_id, run_id, status, exit_code)
        except Exception as exc:
            await self._update(project_id, run_id, output=f"\n[action] {exc}\n")
            await self._finish(project_id, run_id, "failed", None)
        finally:
            if parent_watcher is not None:
                parent_watcher.cancel()
                await asyncio.gather(parent_watcher, return_exceptions=True)
            self.processes.pop(run_id, None)
            self.stopping.discard(run_id)

    async def _terminate(self, proc: asyncio.subprocess.Process, grace: float):
        group_accessible = True
        try:
            await asyncio.to_thread(os.killpg, proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except PermissionError:
            group_accessible = False
            if proc.returncode is None:
                await asyncio.to_thread(proc.terminate)
        if not group_accessible:
            try:
                await asyncio.wait_for(proc.wait(), timeout=grace)
            except asyncio.TimeoutError:
                await asyncio.to_thread(proc.kill)
            return
        deadline = asyncio.get_running_loop().time() + grace
        while asyncio.get_running_loop().time() < deadline:
            try:
                await asyncio.to_thread(os.killpg, proc.pid, 0)
            except ProcessLookupError:
                return
            except PermissionError:
                return
            await asyncio.sleep(0.05)
        try:
            await asyncio.to_thread(os.killpg, proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            if proc.returncode is None:
                await asyncio.to_thread(proc.kill)

    async def stop(self, project_id: str, run_id: str) -> dict:
        result = await self.get(project_id, run_id)
        if result["status"] not in ACTIVE:
            return result
        self.stopping.add(run_id)
        result = await self._update(project_id, run_id, status="stopping")
        if result["status"] not in ACTIVE:
            self.stopping.discard(run_id)
            return result
        await self._bus().publish({"type": "action_run_stopping", "project_id": project_id, "task_id": result["task_id"], **result})
        proc = self.processes.get(run_id)
        if proc is not None:
            await self._terminate(proc, 3)
        return result


def _append_log(path: Path, value: str):
    with path.open("a", encoding="utf-8") as stream:
        stream.write(value)


action_runtime = ActionRuntime()
