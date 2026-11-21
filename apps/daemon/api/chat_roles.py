"""Host-local role binding for ordinary project conversations."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from agent_assistants.chat_roles import RoleBinding
from api.chat_session import _enforce_project_scope, _error_status, _module, _run_db
from api.role_center import authorize

router = APIRouter(prefix='/api/chat-sessions', dependencies=[Depends(authorize)])


class BindingRequest(BaseModel):
    project_id: str
    binding: RoleBinding | None


async def invoke(project_id, operation):
    _enforce_project_scope(project_id)
    try:
        return await _run_db(project_id, operation)
    except FileNotFoundError as exc:
        raise HTTPException(404, 'Role or expert group member does not exist, please reselect') from exc
    except ValueError as exc:
        raise HTTPException(_error_status(exc), str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, 'Failed to read role center, please retry') from exc


@router.get('/{session_id}/role-binding')
async def get_binding(session_id: str, project_id: str):
    return await invoke(project_id, lambda: _module().get_role_binding(project_id, session_id))


@router.put('/{session_id}/role-binding')
async def set_binding(session_id: str, body: BindingRequest):
    binding = body.binding.model_dump() if body.binding else None
    return await invoke(body.project_id, lambda: _module().set_role_binding(body.project_id, session_id, binding))
