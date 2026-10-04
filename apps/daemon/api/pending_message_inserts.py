"""Project-local pending message insert API."""

from fastapi import APIRouter, HTTPException, Query

from schemas.base import BaseSchema
from services.pending_message_inserts import (
    clear_pending_inserts,
    create_pending_insert,
    delete_pending_insert,
    list_pending_inserts,
    reorder_pending_inserts,
    update_pending_insert,
)

router = APIRouter(prefix="/api/pending-message-inserts", tags=["待插入消息"])


class PendingInsertCreateRequest(BaseSchema):
    project_id: str
    target_message_id: str
    content: str


class PendingInsertUpdateRequest(BaseSchema):
    project_id: str
    content: str


class PendingInsertReorderRequest(BaseSchema):
    project_id: str
    target_message_id: str
    ids: list[str]


async def _run_db(project_id: str, operation):
    from main import project_manager

    return await project_manager.run_db(project_id, lambda _project: operation())


@router.get("")
async def get_pending_inserts(
    project_id: str = Query(...),
    target_message_id: str = Query(...),
):
    return {
        "items": await _run_db(
            project_id,
            lambda: list_pending_inserts(target_message_id),
        )
    }


@router.post("")
async def add_pending_insert(req: PendingInsertCreateRequest):
    try:
        return await _run_db(
            req.project_id,
            lambda: create_pending_insert(
                req.target_message_id,
                req.content,
                None,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/{insert_id}")
async def edit_pending_insert(insert_id: str, req: PendingInsertUpdateRequest):
    try:
        return await _run_db(
            req.project_id,
            lambda: update_pending_insert(insert_id, req.content),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404 if "不存在" in str(exc) else 400, detail=str(exc)) from exc


@router.put("/reorder")
async def reorder_pending_insert_items(req: PendingInsertReorderRequest):
    try:
        return {
            "items": await _run_db(
                req.project_id,
                lambda: reorder_pending_inserts(req.target_message_id, req.ids),
            )
        }
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/{insert_id}")
async def remove_pending_insert(insert_id: str, project_id: str = Query(...)):
    return {
        "deleted": await _run_db(
            project_id,
            lambda: delete_pending_insert(insert_id),
        )
    }


@router.delete("")
async def remove_all_pending_inserts(
    project_id: str = Query(...),
    target_message_id: str = Query(...),
):
    return {
        "deleted": await _run_db(
            project_id,
            lambda: clear_pending_inserts(target_message_id),
        )
    }
