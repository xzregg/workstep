"""Task-scoped coordinator proposal writes shared by both share transports."""

import re

from fastapi import HTTPException
from pydantic import BaseModel, Field


class ShareActionConfirmation(BaseModel):
    idempotency_key: str = Field(min_length=1, max_length=128, pattern=r"^\S+$")
    overwrite: bool = False


async def apply_shared_coordinator_action(project_id, task_id, proposal_id, confirmation=None):
    from main import coordinator_module, project_manager
    from services.shared_task_scope import validate_proposal
    from api.shared_task_scope import run_scope_db

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", proposal_id):
        raise HTTPException(404, "Action proposal unavailable")
    if coordinator_module is None or project_manager is None:
        raise HTTPException(503, "Coordinator is not initialized")

    await run_scope_db(project_id, lambda project: validate_proposal(project, task_id, proposal_id))
    try:
        if confirmation is None:
            return await coordinator_module.cancel_action(project_id, task_id, proposal_id)
        return await coordinator_module.confirm_action(
            project_id, task_id, proposal_id, confirmation.idempotency_key,
            overwrite=confirmation.overwrite,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (RuntimeError, FileExistsError) as exc:
        raise HTTPException(409, str(exc)) from exc
