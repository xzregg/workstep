"""Project schedule REST interface."""

from fastapi import APIRouter, Body, HTTPException, Query

from schemas.schedule import CreateScheduleRequest, UpdateScheduleRequest
from services.schedule import ScheduleValidationError, preview_rule

router = APIRouter(prefix="/api/schedule", tags=["定时任务"])


def _module():
    from main import schedule_module
    if schedule_module is None:
        raise HTTPException(status_code=503, detail="Schedule module not initialized")
    return schedule_module


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except ScheduleValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/preview")
async def preview_schedule(rule: dict = Body(...)):
    try:
        return preview_rule(rule)
    except ScheduleValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/list")
async def list_schedules(project_id: str = Query(...)):
    return {"schedules": _call(_module().list, project_id)}


@router.post("/create")
async def create_schedule(req: CreateScheduleRequest, project_id: str = Query(...)):
    return _call(_module().create, project_id, **req.model_dump())


@router.get("/{schedule_id}")
async def get_schedule(schedule_id: str, project_id: str = Query(...)):
    return _call(_module().get, project_id, schedule_id)


@router.patch("/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    req: UpdateScheduleRequest,
    project_id: str = Query(...),
):
    return _call(
        _module().update,
        project_id,
        schedule_id,
        **req.model_dump(exclude_unset=True),
    )


@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: str, project_id: str = Query(...)):
    _call(_module().delete, project_id, schedule_id)
    return {"deleted": True, "id": schedule_id}


@router.post("/{schedule_id}/pause")
async def pause_schedule(schedule_id: str, project_id: str = Query(...)):
    return _call(_module().pause, project_id, schedule_id)


@router.post("/{schedule_id}/resume")
async def resume_schedule(schedule_id: str, project_id: str = Query(...)):
    return _call(_module().resume, project_id, schedule_id)


@router.get("/{schedule_id}/runs")
async def list_schedule_runs(
    schedule_id: str,
    project_id: str = Query(...),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    return {
        "runs": _call(_module().list_runs, project_id, schedule_id, limit, offset),
        "limit": limit,
        "offset": offset,
    }
