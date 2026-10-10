"""Chrome push subscription management for completion alerts."""

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from services.remote_access import get_current_actor, authenticated_remote_dispatch
from api.desktop_security import browser_origin_allowed

router = APIRouter(prefix="/api/completion-notifications", tags=["完成通知"])


class PushSubscription(BaseModel):
    endpoint: str = Field(max_length=2048)
    keys: dict[str, str]


class RegisterRequest(BaseModel):
    subscription: PushSubscription
    project_id: str = Field(min_length=1, max_length=120)
    project_name: str = Field(max_length=120)
    session_ids: list[str] = Field(default_factory=list, max_length=100)
    task_ids: list[str] = Field(default_factory=list, max_length=100)


def _check_origin(request: Request):
    # The project RPC dispatcher has already authenticated the connection and
    # bound this request to its project; it intentionally drops browser headers.
    if authenticated_remote_dispatch() is None and not browser_origin_allowed(request):
        raise HTTPException(status_code=403, detail="通知订阅要求同源请求")


@router.get("/public-key")
async def public_key(request: Request):
    return {"public_key": request.app.state.completion_push.public_key}


@router.get("/recent")
async def recent(request: Request, project_id: str = Query(min_length=1), since: float = 0):
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and actor.project_id != project_id:
        raise HTTPException(status_code=403, detail="不能查看其他项目")
    return {"events": request.app.state.completion_push.recent_for_project(project_id, since)}


@router.post("/subscriptions")
async def register(request: Request, body: RegisterRequest):
    _check_origin(request)
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and actor.project_id != body.project_id:
        raise HTTPException(status_code=403, detail="不能订阅其他项目")
    try:
        await request.app.state.completion_push.register(
            body.subscription.model_dump(), body.project_id, body.project_name,
            body.session_ids, body.task_ids,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"ok": True}


@router.delete("/subscriptions")
async def unregister(request: Request, body: PushSubscription):
    _check_origin(request)
    await request.app.state.completion_push.remove(body.endpoint)
    return {"ok": True}
