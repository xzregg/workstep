"""Platform share inventory and administrator lifecycle controls."""

import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import case, func, select, update

from .identity import COOKIE_NAME, IdentityService
from .identity_api import _check_csrf
from .models import (AdminAssignment, AuditEvent, Device, PlatformProject,
                     PlatformShare, PlatformShareSession, User)

router = APIRouter(prefix="/api/admin/shares")


async def _admin(request: Request, *, mutation: bool = False) -> User:
    token = request.cookies.get(COOKIE_NAME)
    actor, _ = await IdentityService(request.app.state.database).session_user(token)
    if mutation:
        _check_csrf(request, token)
    if actor.status != "active" or actor.must_change_password:
        raise HTTPException(status_code=403, detail="Administrator access required")
    async with request.app.state.database.session() as session:
        assigned = await session.scalar(select(AdminAssignment.id).where(
            AdminAssignment.user_id == actor.id,
            AdminAssignment.role == "super_admin",
            AdminAssignment.revoked_at.is_(None),
        ))
    if assigned is None:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return actor


@router.get("")
async def list_admin_shares(request: Request,
                            project_id: str | None = None,
                            device_id: str | None = None,
                            status: str | None = Query(None, pattern="^(active|paused|revoked|expired)$"),
                            mode: str | None = Query(None, pattern="^(read_only|interactive)$"),
                            q: str = Query("", max_length=100),
                            offset: int = Query(0, ge=0),
                            limit: int = Query(20, ge=1, le=100)):
    await _admin(request)
    now = datetime.now(timezone.utc)
    state = case(
        (PlatformShare.revoked_at.is_not(None), "revoked"),
        (PlatformShare.expires_at <= now, "expired"),
        (PlatformShare.status == "paused", "paused"),
        else_="active",
    )
    conditions = []
    if project_id:
        conditions.append(PlatformShare.project_id == project_id)
    if device_id:
        conditions.append(PlatformShare.device_id == device_id)
    if status:
        conditions.append(state == status)
    if mode:
        conditions.append(PlatformShare.mode == mode)
    if q.strip():
        pattern = f"%{q.strip().replace('%', r'\%').replace('_', r'\_')}%"
        conditions.append(PlatformShare.title.ilike(pattern, escape="\\"))
    visits = select(
        PlatformShareSession.share_id.label("share_id"),
        func.count(PlatformShareSession.id).label("visit_count"),
        func.max(func.coalesce(PlatformShareSession.last_seen_at,
                               PlatformShareSession.created_at)).label("last_seen_at"),
    ).group_by(PlatformShareSession.share_id).subquery()
    async with request.app.state.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(PlatformShare)
                                     .where(*conditions)) or 0
        rows = (await session.execute(select(
            PlatformShare, User.username, Device.name, PlatformProject.name,
            state.label("effective_status"), visits.c.visit_count, visits.c.last_seen_at,
        ).join(User, User.id == PlatformShare.created_by_user_id)
         .join(Device, Device.id == PlatformShare.device_id)
         .join(PlatformProject, PlatformProject.id == PlatformShare.project_id)
         .outerjoin(visits, visits.c.share_id == PlatformShare.id)
         .where(*conditions)
         .order_by(PlatformShare.created_at.desc(), PlatformShare.id.desc())
         .offset(offset).limit(limit))).all()
    return {"total": total, "shares": [{
        "id": share.id, "title": share.title, "device_id": share.device_id,
        "device_name": device_name, "project_id": share.project_id,
        "project_name": project_name, "task_id": share.task_id,
        "mode": share.mode, "created_by": username,
        "created_at": share.created_at, "expires_at": share.expires_at,
        "status": effective_status, "visit_count": visit_count or 0,
        "last_seen_at": last_seen_at,
    } for share, username, device_name, project_name, effective_status,
        visit_count, last_seen_at in rows]}


@router.post("/{share_id}/{action}", status_code=204)
async def change_admin_share(request: Request, share_id: str, action: str):
    if action not in ("pause", "resume", "revoke"):
        raise HTTPException(status_code=404, detail="Share action unavailable")
    actor = await _admin(request, mutation=True)
    async with request.app.state.database.session() as session:
        async with session.begin():
            share = await session.get(PlatformShare, share_id)
            if share is None:
                raise HTTPException(status_code=404, detail="Share unavailable")
            if share.revoked_at is not None:
                if action == "revoke":
                    return
                raise HTTPException(status_code=409, detail="Share revoked")
            if action != "revoke" and share.expires_at is not None:
                expiry = share.expires_at.replace(tzinfo=timezone.utc) if share.expires_at.tzinfo is None else share.expires_at
                if expiry <= datetime.now(timezone.utc):
                    raise HTTPException(status_code=409, detail="Share expired")
            project = await session.get(PlatformProject, share.project_id)
            if action == "pause":
                share.status = "paused"
            elif action == "resume":
                device = await session.get(Device, share.device_id)
                if (device is None or device.status != "active" or project is None
                        or project.status != "active"
                        or project.access_mode != "remote_published"):
                    raise HTTPException(status_code=409, detail="Share host unavailable")
                share.status = "active"
            else:
                share.status = "revoked"
                share.revoked_at = datetime.now(timezone.utc)
                await session.execute(update(PlatformShareSession).where(
                    PlatformShareSession.share_id == share.id,
                    PlatformShareSession.revoked_at.is_(None),
                ).values(revoked_at=share.revoked_at))
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id, device_id=share.device_id,
                action=f"platform_share.{action}", result="success",
                project_id=project.host_project_id if project else None,
                task_id=share.task_id,
                actor_username=actor.username, actor_name=actor.display_name,
                actor_type="user", initiated_by_user_id=actor.id,
                initiated_by_username=actor.username,
                metadata_json=json.dumps({"share_id": share.id}),
            ))
