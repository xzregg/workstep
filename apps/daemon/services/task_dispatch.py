"""Create independent downstream tasks from workflow dispatch steps."""

from __future__ import annotations

import asyncio
import json
import base64
import shutil
import sys
import ctypes
from pathlib import Path

from models import Task
from services.artifact_rounds import select_upstream_round
from services.task import TaskService
from services.workflow_definition import WorkflowDefinition
from services.remote_project import REMOTE_REQUEST_BODY_LIMIT, RemoteHttpRequest


def _try_clone_file(source: Path, destination: Path) -> bool:
    """Clone a file without copying its data when the filesystem supports it."""
    if sys.platform == "darwin":
        try:
            clonefile = ctypes.CDLL(None, use_errno=True).clonefile
            clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
            clonefile.restype = ctypes.c_int
            return clonefile(
                bytes(source),
                bytes(destination),
                0,
            ) == 0
        except (AttributeError, OSError):
            return False

    if sys.platform.startswith("linux"):
        import fcntl

        # Linux fs.h: clone the source file's extents into the destination.
        ficlone = 0x40049409
        created = False
        try:
            with source.open("rb") as source_file:
                with destination.open("xb") as destination_file:
                    created = True
                    fcntl.ioctl(destination_file.fileno(), ficlone, source_file.fileno())
            shutil.copystat(source, destination)
            return True
        except OSError:
            if created:
                destination.unlink(missing_ok=True)
            return False

    return False


def _copy_local_artifact(source: Path, destination: Path) -> None:
    """Prefer a copy-on-write clone and safely fall back to a full copy."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not _try_clone_file(source, destination):
        shutil.copy2(source, destination)


class TaskDispatchService:
    """Small execution seam for the terminal ``task_dispatch`` step."""

    def __init__(self, project_manager, event_bus, workflow_runtime, *, remote_client=None):
        self._project_manager = project_manager
        self._task_service = TaskService(event_bus)
        self._workflow_runtime = workflow_runtime
        self._remote_client = remote_client

    async def _run_db(self, project_id: str, operation):
        run_db = getattr(self._project_manager, "run_db", None)
        if run_db is not None:
            return await run_db(project_id, operation)

        def execute():
            with self._project_manager.activate_project_by_id(project_id) as project:
                return operation(project)

        return await asyncio.to_thread(execute)

    async def dispatch(
        self,
        *,
        source_project_id: str,
        task: Task,
        step,
        workflow_run,
        artifacts_dir: Path,
    ) -> dict:
        config = dict(step.dispatch or {})
        target_project_id = str(config["targetProjectId"])
        target_workflow_id = str(config["targetWorkflowId"])
        target_start_step_key = str(config["targetStartStepKey"])
        dispatch_id = self._dispatch_id(task, step, workflow_run)
        target = self._project_manager.get_project_by_id(target_project_id)

        source_workflow = task.workflow_id or "default"
        lineage = self._load_lineage(task)
        workflow_token = f"{source_project_id}/{source_workflow}"
        target_token = f"{target_project_id}/{target_workflow_id}"
        if target_token in (*lineage, workflow_token) or len(lineage) >= 16:
            raise ValueError("检测到流程步骤循环派发，已阻止创建下游任务")

        if target is None:
            return await self._dispatch_remote(
                target_project_id=target_project_id,
                target_workflow_id=target_workflow_id,
                target_start_step_key=target_start_step_key,
                config=config,
                dispatch_id=dispatch_id,
                task=task,
                step=step,
                source_project_id=source_project_id,
                lineage=lineage,
                artifacts_dir=artifacts_dir,
            )

        workflow = target.workflow_by_id(target_workflow_id)
        if workflow is None:
            raise ValueError(f"目标流程不存在: {target_workflow_id}")
        definition = WorkflowDefinition.load(workflow["steps"])
        compiled = definition.compile().to_steps_config()
        valid_keys = {item["key"] for item in compiled["steps"]}
        if target_start_step_key not in valid_keys:
            raise ValueError(f"目标步骤不存在: {target_start_step_key}")

        manifest = await asyncio.to_thread(
            self._copy_inputs,
            source_task=task,
            source_workflow=source_workflow,
            source_project_id=source_project_id,
            source_step_keys=step.depends_on,
            source_artifacts_dir=artifacts_dir,
            target_workstep_dir=target.workstep_dir,
            dispatch_id=dispatch_id,
        )
        description = self._description(task)
        execution_mode = (
            "immediate"
            if config.get("startMode", "inherit") == "immediate"
            else "workflow"
        )
        def create_or_load():
            target_project = self._project_manager.get_project_by_id(target_project_id)
            existing = Task.get_or_none(Task.source_dispatch_id == dispatch_id)
            if existing is None:
                created = self._task_service.create_task(
                    project_id=target_project_id,
                    title=task.title,
                    cwd=str(target_project.path),
                    description=description,
                    workflow=workflow["steps"],
                    start_step_key=target_start_step_key,
                    workflow_id=target_workflow_id,
                    source_dispatch_id=dispatch_id,
                    source_project_id=source_project_id,
                    source_task_id=task.id,
                    source_step_key=step.key,
                    input_manifest=manifest,
                    dispatch_lineage=[*lineage, workflow_token],
                )
            else:
                created = self._task_service.get_task(existing.id)
            return created

        created = await self._run_db(
            target_project_id, lambda _project: create_or_load()
        )
        if execution_mode == "immediate" or (
            execution_mode == "workflow"
            and definition.auto_start_enabled(target_start_step_key)
        ):
            await self._workflow_runtime.start(target_project_id, created["id"], "")
        return created

    async def _dispatch_remote(
        self, *, target_project_id, target_workflow_id, target_start_step_key,
        config, dispatch_id, task, step, source_project_id, lineage, artifacts_dir,
    ) -> dict:
        client_manager = self._remote_client
        if client_manager is None:
            raise ValueError("远程项目连接服务未初始化")
        workflow_response = await client_manager.request(
            target_project_id,
            RemoteHttpRequest(
                request_id=f"{dispatch_id}:workflow",
                method="GET",
                path=f"/api/workflow/{target_workflow_id}",
                query={"project_id": target_project_id},
            ),
        )
        if not 200 <= workflow_response.status < 300:
            raise ValueError(f"读取远程目标流程失败: {workflow_response.json()}")
        workflow = workflow_response.json()
        definition = WorkflowDefinition.load(workflow["steps"])
        compiled = definition.compile().to_steps_config()
        valid_keys = {item["key"] for item in compiled["steps"]}
        if target_start_step_key not in valid_keys:
            raise ValueError(f"目标步骤不存在: {target_start_step_key}")
        source_workflow = task.workflow_id or "default"
        files = await asyncio.to_thread(
            self._collect_remote_inputs,
            artifacts_dir,
            source_workflow,
            task.id,
            step.depends_on,
        )
        payload = {
            "dispatch_id": dispatch_id,
            "title": task.title,
            "description": self._description(task),
            "workflow_id": target_workflow_id,
            "start_step_key": target_start_step_key,
            "auto_start": config.get("startMode", "inherit") == "immediate" or definition.auto_start_enabled(target_start_step_key),
            "source_project_id": source_project_id,
            "source_task_id": task.id,
            "source_step_key": step.key,
            "dispatch_lineage": [*lineage, f"{source_project_id}/{source_workflow}"],
            "files": files,
        }
        body = json.dumps(payload, ensure_ascii=False).encode()
        if len(body) > REMOTE_REQUEST_BODY_LIMIT:
            raise ValueError("远程输入产物超过单次派发大小限制（64 MiB）")
        response = await client_manager.request(
            target_project_id,
            RemoteHttpRequest(
                request_id=f"{dispatch_id}:receive",
                method="POST",
                path="/api/task-dispatch/receive",
                query={"project_id": target_project_id},
                headers={"content-type": "application/json"},
                body=body,
            ),
        )
        if not 200 <= response.status < 300:
            raise ValueError(f"远程创建下游任务失败: {response.json()}")
        return response.json()

    @staticmethod
    def _collect_remote_inputs(
        artifacts_dir: Path,
        source_workflow: str,
        task_id: str,
        source_step_keys: list[str],
    ) -> list[dict]:
        files = []
        for source_step_key in source_step_keys:
            selected = select_upstream_round(
                artifacts_dir,
                source_workflow,
                task_id,
                source_step_key,
            )
            if selected is None:
                continue
            source_root = selected.path
            for source in sorted(source_root.rglob("*")):
                if source.is_file() and source.name != "manifest.json":
                    files.append({
                        "source_step_key": source_step_key,
                        "source_round": selected.round,
                        "name": source.name,
                        "relative_path": str(source.relative_to(source_root)),
                        "content_b64": base64.b64encode(source.read_bytes()).decode(),
                    })
        return files

    @staticmethod
    def _dispatch_id(task: Task, step, workflow_run) -> str:
        run_id = getattr(workflow_run, "id", None) or task.id
        return f"{run_id}:{step.key}"

    @staticmethod
    def _load_lineage(task: Task) -> list[str]:
        if not task.dispatch_lineage_json:
            return []
        try:
            value = json.loads(task.dispatch_lineage_json)
        except (TypeError, json.JSONDecodeError):
            return []
        return [str(item) for item in value] if isinstance(value, list) else []

    @staticmethod
    def _copy_inputs(
        *,
        source_task,
        source_workflow: str,
        source_project_id: str,
        source_step_keys: list[str],
        source_artifacts_dir: Path,
        target_workstep_dir: Path,
        dispatch_id: str,
    ) -> list[dict]:
        target_root = target_workstep_dir / "task-inputs" / dispatch_id
        manifest: list[dict] = []
        for step_key in source_step_keys:
            selected = select_upstream_round(
                source_artifacts_dir,
                source_workflow,
                source_task.id,
                step_key,
            )
            if selected is None:
                continue
            source_root = selected.path
            for source in sorted(source_root.rglob("*")):
                if not source.is_file() or source.name == "manifest.json":
                    continue
                relative = source.relative_to(source_root)
                destination = target_root / step_key / relative
                _copy_local_artifact(source, destination)
                manifest.append({
                    "source_project_id": source_project_id,
                    "source_task_id": source_task.id,
                    "source_step_key": step_key,
                    "source_round": selected.round,
                    "name": source.name,
                    "path": str(destination),
                })
        return manifest

    @staticmethod
    def _description(task) -> str:
        # Lineage and copied inputs have dedicated fields.  Keep the task
        # description user-authored so downstream LLM prompts do not expose
        # internal project/task/dispatch identifiers or duplicate paths.
        return str(task.description or "").strip()


def prepare_received_dispatch(project_manager, task_service, project_id, req):
    project = project_manager.get_project_by_id(project_id)
    if project is None:
        raise ValueError("Project not found")
    workflow = project.workflow_by_id(req.workflow_id)
    if workflow is None:
        raise ValueError("目标流程不存在")
    existing = Task.get_or_none(Task.source_dispatch_id == req.dispatch_id)
    if existing is not None:
        return {"existing": task_service.get_task(existing.id)}
    root = project.workstep_dir / "task-inputs" / req.dispatch_id
    manifest = []
    for item in req.files:
        relative = Path(item.relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("输入产物路径非法")
        destination = (root / item.source_step_key / relative).resolve()
        destination.relative_to(root.resolve())
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(base64.b64decode(item.content_b64, validate=True))
        manifest.append({
            "source_step_key": item.source_step_key,
            "source_round": item.source_round,
            "name": item.name,
            "path": str(destination),
        })
    return {"cwd": str(project.path), "manifest": manifest}
