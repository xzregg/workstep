"""Create independent downstream tasks from workflow dispatch stages."""

from __future__ import annotations

import json
import base64
import shutil
from pathlib import Path

from models import Task
from services.task import TaskService
from services.workflow_definition import WorkflowDefinition
from services.remote_project import RemoteHttpRequest


class TaskDispatchService:
    """Small execution seam for the terminal ``task_dispatch`` stage."""

    def __init__(self, project_manager, event_bus, workflow_runtime):
        self._project_manager = project_manager
        self._task_service = TaskService(event_bus)
        self._workflow_runtime = workflow_runtime

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
            raise ValueError("检测到流程阶段循环派发，已阻止创建下游任务")

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
            raise ValueError(f"目标阶段不存在: {target_start_step_key}")

        manifest = self._copy_inputs(
            source_task=task,
            source_workflow=source_workflow,
            source_project_id=source_project_id,
            source_step_keys=step.depends_on,
            source_artifacts_dir=artifacts_dir,
            target_workstep_dir=target.workstep_dir,
            dispatch_id=dispatch_id,
        )
        description = self._description(task, source_project_id, step.key, manifest)
        execution_mode = (
            "immediate"
            if config.get("startMode", "inherit") == "immediate"
            else "workflow"
        )
        with self._project_manager.activate_project_by_id(target_project_id) as target_project:
            existing = Task.get_or_none(Task.source_dispatch_id == dispatch_id)
            if existing is None:
                created = self._task_service.create_task(
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
        from api.remote_project import client_manager

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
            raise ValueError(f"目标阶段不存在: {target_start_step_key}")
        source_workflow = task.workflow_id or "default"
        files = []
        for source_step_key in step.depends_on:
            source_root = artifacts_dir / source_workflow / task.id / source_step_key
            if not source_root.is_dir():
                continue
            for source in sorted(source_root.rglob("*")):
                if source.is_file():
                    files.append({
                        "source_step_key": source_step_key,
                        "name": source.name,
                        "relative_path": str(source.relative_to(source_root)),
                        "content_b64": base64.b64encode(source.read_bytes()).decode(),
                    })
        payload = {
            "dispatch_id": dispatch_id,
            "title": task.title,
            "description": self._description(task, source_project_id, step.key, files),
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
        if len(body) > 12 * 1024 * 1024:
            raise ValueError("远程输入产物超过单次派发大小限制（12 MiB）")
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
            source_root = source_artifacts_dir / source_workflow / source_task.id / step_key
            if not source_root.is_dir():
                continue
            for source in sorted(source_root.rglob("*")):
                if not source.is_file():
                    continue
                relative = source.relative_to(source_root)
                destination = target_root / step_key / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                manifest.append({
                    "source_project_id": source_project_id,
                    "source_task_id": source_task.id,
                    "source_step_key": step_key,
                    "name": source.name,
                    "path": str(destination),
                })
        return manifest

    @staticmethod
    def _description(task, source_project_id: str, step_key: str, manifest: list[dict]) -> str:
        parts = [task.description or "", "", "## 来源任务", f"项目：{source_project_id}", f"任务：{task.id}", f"阶段：{step_key}"]
        if manifest:
            parts.extend([
                "",
                "## 外部输入产物",
                *[
                    f"- {item.get('path') or item.get('relative_path') or item.get('name', '未命名产物')}"
                    for item in manifest
                ],
            ])
        else:
            parts.extend(["", "## 外部输入产物", "- （上游阶段没有可复制的文件产物）"])
        return "\n".join(parts).strip()
