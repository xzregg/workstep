"""One-time Desktop to daemon managed-session bootstrap."""

from fastapi import APIRouter, HTTPException, Request
import httpx
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/managed")


@router.get("/mode")
async def managed_mode(request: Request):
    service = getattr(request.app.state, "gateway_client", None)
    result = {"managed": bool(service is not None and service.managed_config is not None)}
    if request.scope.get('gateway_remote_actor') is not None:
        from api.desktop_security import gateway_device_owner
        result['can_manage_remote_projects'] = gateway_device_owner(request)
    return result


class BootstrapInput(BaseModel):
    device_authorization: str = Field(min_length=1, max_length=8192)
    device_proof: str = Field(min_length=1, max_length=512)
    control_private_key_pem: str = Field(min_length=1, max_length=4096)
    control_public_key_pem: str = Field(min_length=1, max_length=4096)
    control_delegation_signature: str = Field(min_length=1, max_length=512)


@router.post("/bootstrap")
async def bootstrap(request: Request, body: BootstrapInput):
    service = request.app.state.gateway_client
    if service.managed_config is None:
        raise HTTPException(status_code=404, detail="Managed Gateway unavailable")
    try:
        token, actor = await service.bootstrap(
            body.device_authorization, body.device_proof,
            body.control_private_key_pem, body.control_public_key_pem,
            body.control_delegation_signature,
        )
    except (OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail="Gateway unavailable") from exc
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Invalid managed authorization") from exc
    return {"local_session": token, "user_id": actor.user_id, "device_id": actor.device_id}


@router.get("/control-status")
async def control_status(request: Request):
    service = request.app.state.gateway_client
    if service.managed_config is None:
        raise HTTPException(status_code=404, detail="Managed Gateway unavailable")
    client = service.control_client
    policy = service.policy_cache.current
    return {"online": bool(client and client.online),
            "authorization_required": bool(client and client.authorization_required),
            "policy_revision": policy.revision if policy else None,
            "policy_expires_at": policy.expires_at if policy else None,
            "controlled_actions_available": bool(policy and policy.valid)}
