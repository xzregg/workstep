"""One-time Desktop to daemon managed-session bootstrap."""

from fastapi import APIRouter, HTTPException, Request
import httpx
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/managed")


class BootstrapInput(BaseModel):
    device_authorization: str = Field(min_length=1, max_length=8192)
    device_proof: str = Field(min_length=1, max_length=512)


@router.post("/bootstrap")
async def bootstrap(request: Request, body: BootstrapInput):
    service = request.app.state.gateway_client
    if service.managed_config is None:
        raise HTTPException(status_code=404, detail="Managed Gateway unavailable")
    try:
        token, actor = await service.bootstrap(body.device_authorization, body.device_proof)
    except (OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail="Gateway unavailable") from exc
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Invalid managed authorization") from exc
    return {"local_session": token, "user_id": actor.user_id, "device_id": actor.device_id}
