"""Configured task Action endpoints."""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query

from schemas.base import BaseSchema
from services.action_runtime import ActionError, action_runtime
from services.quick_buttons import ACTION_ID
from services.workflow_actions import create_project_action, normalize_action_payload


task_router = APIRouter(prefix="/api/tasks", tags=["快捷动作"])
run_router = APIRouter(prefix="/api/action-runs", tags=["快捷动作"])
project_router = APIRouter(prefix="/api/projects", tags=["快捷动作"])
session_router = APIRouter(prefix="/api/project-actions/sessions", tags=["快捷动作"])


class RunActionRequest(BaseSchema):
    button_id: str
    source: str = "project"
    step_key: str | None = None
    confirmed: bool = False
    action_input: str = ""


class RunProjectActionRequest(BaseSchema):
    button_id: str
    confirmed: bool = False
    action_input: str = ""


@session_router.get("/{session_id}")
async def list_session_actions(session_id: str, project_id: str = Query(...)):
    try:
        return await action_runtime.list_session(project_id, session_id)
    except ActionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@session_router.post("/{session_id}/run")
async def run_session_action(session_id: str, request: RunProjectActionRequest, project_id: str = Query(...)):
    try:
        return await action_runtime.start_session(
            project_id, session_id, request.button_id, request.confirmed, request.action_input,
        )
    except ActionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@project_router.post("/{project_id}/actions/{action_id}/directory")
async def ensure_action_directory(project_id: str, action_id: str, workflow_id: str | None = Query(None)):
    from main import project_manager

    if not ACTION_ID.fullmatch(action_id):
        raise HTTPException(400, "Action ID 无效")
    project = project_manager.get_project_by_id(project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    from services.task_queries import workflow_exists
    if workflow_id:
        exists = await project_manager.run_db(
            project_id, lambda _project: workflow_exists(workflow_id),
        )
        if not exists:
            raise HTTPException(404, "流程不存在")

    def create():
        root = Path(project.path).resolve()
        workstep = project.workstep_dir.resolve()
        target = (workstep / "artifacts" / workflow_id / "actions" / action_id) if workflow_id else (workstep / "actions" / action_id)
        if not target.resolve().is_relative_to(workstep):
            raise ActionError("Action 目录超出项目根目录")
        target.mkdir(parents=True, exist_ok=True)
        return {"path": target.relative_to(root).as_posix() if target.is_relative_to(root) else str(target)}

    try:
        return await asyncio.to_thread(create)
    except ActionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@project_router.post("/{project_id}/actions")
async def create_project_action_shortcut(project_id: str, payload: dict = Body(...)):
    from main import project_manager

    try:
        cleaned = normalize_action_payload(payload)
        return await project_manager.run_db(
            project_id,
            lambda project: create_project_action(project, project_id, cleaned),
        )
    except FileExistsError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@task_router.get("/{task_id}/actions")
async def list_task_actions(task_id: str, project_id: str = Query(...), step_key: str | None = Query(None)):
    try:
        return await action_runtime.list_task(project_id, task_id, step_key)
    except ActionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@task_router.post("/{task_id}/actions/run")
async def run_task_action(task_id: str, request: RunActionRequest, project_id: str = Query(...)):
    try:
        return await action_runtime.start(
            project_id, task_id, request.button_id, request.source,
            request.step_key, request.confirmed, request.action_input,
        )
    except ActionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@run_router.get("/{run_id}")
async def get_action_run(run_id: str, project_id: str = Query(...)):
    try:
        return await action_runtime.get(project_id, run_id)
    except ActionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@run_router.post("/{run_id}/stop")
async def stop_action_run(run_id: str, project_id: str = Query(...)):
    try:
        return await action_runtime.stop(project_id, run_id)
    except ActionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
