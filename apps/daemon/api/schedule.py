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


async def _call(project_id, operation, *args, **kwargs):
    from main import project_manager

    try:
        return await project_manager.run_db(
            project_id,
            lambda _project: operation(project_id, *args, **kwargs),
        )
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
async def list_schedules(project_id: str = Query(...), target_type: str | None = None, task_id: str | None = None):
    return {"schedules": await _call(project_id, _module().list, target_type=target_type, task_id=task_id)}


@router.get("/notification-options")
async def schedule_notification_options(project_id: str = Query(...), task_id: str | None = None):
    from services.schedule_notifications import notification_options
    return await _call(project_id, notification_options, task_id)


@router.post("/{schedule_id}/runs/{run_id}/notification/retry")
async def retry_notification(schedule_id: str, run_id: str, project_id: str = Query(...)):
    from services.schedule_notifications import notification_run_status
    await _call(project_id, notification_run_status, schedule_id, run_id)
    await _module()._notify_run(project_id, run_id, retry=True)
    return await _call(project_id, notification_run_status, schedule_id, run_id)


@router.post("/create")
async def create_schedule(req: CreateScheduleRequest, project_id: str = Query(...)):
    return await _call(project_id, _module().create, **req.model_dump())


@router.get("/{schedule_id}")
async def get_schedule(schedule_id: str, project_id: str = Query(...)):
    return await _call(project_id, _module().get, schedule_id)


@router.patch("/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    req: UpdateScheduleRequest,
    project_id: str = Query(...),
):
    return await _call(
        project_id,
        _module().update,
        schedule_id,
        **req.model_dump(exclude_unset=True),
    )


@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: str, project_id: str = Query(...)):
    await _call(project_id, _module().delete, schedule_id)
    return {"deleted": True, "id": schedule_id}


@router.post("/{schedule_id}/pause")
async def pause_schedule(schedule_id: str, project_id: str = Query(...)):
    return await _call(project_id, _module().pause, schedule_id)


@router.post("/{schedule_id}/resume")
async def resume_schedule(schedule_id: str, project_id: str = Query(...)):
    return await _call(project_id, _module().resume, schedule_id)


@router.get("/{schedule_id}/runs")
async def list_schedule_runs(
    schedule_id: str,
    project_id: str = Query(...),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    return {
        "runs": await _call(
            project_id, _module().list_runs, schedule_id, limit, offset
        ),
        "limit": limit,
        "offset": offset,
    }
