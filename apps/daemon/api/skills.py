"""Project-level skill center API."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.project import project_manager
from services.skill_center import skill_center


router = APIRouter(prefix="/api/skills", tags=["skills"])


class ProjectSkillToggleRequest(BaseModel):
    skill_id: str = Field(min_length=1, max_length=128)
    enabled: bool


class ProjectSkillBatchToggleRequest(BaseModel):
    skill_ids: list[str] = Field(min_length=1, max_length=1000)
    enabled: bool


def _project(project_id: str):
    if not project_id.strip():
        raise HTTPException(status_code=400, detail="需要选择项目")
    project = project_manager.get_project_by_id(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    return project


def _payload(project, skills) -> dict:
    return {
        "project_id": project.id,
        "project_name": project.name,
        "project_path": str(project.path),
        "skills": [skill.to_dict() for skill in skills],
        "compatible_engines": [
            "codex",
            "codex_sdk",
            "claude",
            "claude_agent_sdk",
            "qoder_sdk",
            "hermes",
            "openclaw",
            "deepseek_harness",
            "pydantic_ai",
        ],
        "takes_effect": "next_run",
    }


@router.get("")
async def list_skills(project_id: str = Query(default="")):
    project = _project(project_id)
    skills = await asyncio.to_thread(skill_center.list_project, project.path)
    return _payload(project, skills)


@router.post("/rescan")
async def rescan_skills(project_id: str = Query(default="")):
    project = _project(project_id)
    skills = await asyncio.to_thread(skill_center.rescan, project.path)
    return _payload(project, skills)


@router.put("/projects/{project_id}")
async def set_project_skill(project_id: str, request: ProjectSkillToggleRequest):
    project = _project(project_id)
    try:
        skills = await asyncio.to_thread(
            skill_center.set_enabled,
            project.path,
            request.skill_id,
            request.enabled,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return _payload(project, skills)


@router.put("/projects/{project_id}/batch")
async def set_project_skills_batch(
    project_id: str, request: ProjectSkillBatchToggleRequest
):
    project = _project(project_id)
    try:
        skills = await asyncio.to_thread(
            skill_center.set_enabled_batch,
            project.path,
            request.skill_ids,
            request.enabled,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return _payload(project, skills)
