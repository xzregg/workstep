"""FastAPI APIRouter for database-free WebRTC signaling."""

from __future__ import annotations

import inspect
import json
import secrets
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .hub import PairRateLimitError, SignalingError, SignalingHub

AuthorizerFn = Callable[[Request, str], tuple[bool, str | None] | Awaitable[tuple[bool, str | None]]]
StunUrlsProvider = Callable[[Request], list[str]]

CLIENT_SESSION_COOKIE = "workstep_webrtc_session"


class PairRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    pair_proof: str = Field(default="", max_length=64, pattern=r"^(?:[0-9a-f]{64})?$")


def create_webrtc_router(
    hub: SignalingHub,
    *,
    stun_urls_provider: StunUrlsProvider,
    authorizer: AuthorizerFn | None = None,
) -> APIRouter:
    """Create a mountable FastAPI router with zero database dependencies."""
    router = APIRouter()

    @router.get("/api/webrtc/config")
    async def webrtc_config(request: Request, device_id: str = Query(default="", max_length=128)):
        summary = (
            hub.device_summary(device_id)
            if device_id
            else {"online": False, "device_id": "", "device_name": ""}
        )
        payload = {
            **summary,
            "stun_urls": list(stun_urls_provider(request)),
            "direct_only": True,
            "session_authorized": False,
        }
        return payload

    @router.post("/api/webrtc/pair")
    async def webrtc_pair(request: Request, body: PairRequest):
        if authorizer is not None:
            decision = authorizer(request, body.device_id)
            if inspect.isawaitable(decision):
                decision = await decision
            allowed, reason = decision
            if not allowed:
                raise HTTPException(status_code=403, detail=reason or "Pairing denied")

        client_ip = request.client.host if request.client else ""
        resolved_stun_urls = list(stun_urls_provider(request))
        try:
            result = hub.pair_client(
                device_id=body.device_id,
                pair_proof=body.pair_proof,
                client_ip=client_ip,
                stun_urls=resolved_stun_urls,
            )
        except PairRateLimitError as exc:
            raise HTTPException(status_code=429, detail=exc.message) from exc
        except SignalingError as exc:
            status = 404 if exc.code == "device_offline" else 403
            raise HTTPException(status_code=status, detail=exc.message) from exc

        payload = {
            **result,
            "stun_urls": resolved_stun_urls,
        }
        response = JSONResponse(payload, headers={"Cache-Control": "no-store"})
        response.set_cookie(
            CLIENT_SESSION_COOKIE,
            result["session_token"],
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
            max_age=hub.session_ttl_seconds,
            path="/",
        )
        return response

    @router.websocket("/ws/webrtc/device")
    async def webrtc_device_ws(ws: WebSocket):
        await ws.accept()
        nonce = secrets.token_urlsafe(32)
        await ws.send_json({"type": "challenge", "nonce": nonce})
        device = None
        try:
            raw_reg = await ws.receive_text()
            msg = json.loads(raw_reg)
            if not isinstance(msg, dict) or msg.get("type") != "register":
                await ws.close(code=4400, reason="registration required")
                return
            device = await hub.register_device(
                nonce=nonce,
                payload=msg,
                ws=ws,
                client_ip=ws.client.host if ws.client else None,
            )
            await ws.send_json({
                "type": "registered",
                "device_id": device.device_id,
                "direct_only": True,
            })

            while True:
                raw = await ws.receive_text()
                try:
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise SignalingError("invalid_payload", "JSON object required")
                    reply = await hub.forward_from_device(device, raw, data)
                    if reply is not None:
                        await ws.send_json(reply)
                except SignalingError as exc:
                    await ws.send_json({"type": "error", "code": exc.code, "message": exc.message})
                except json.JSONDecodeError:
                    await ws.send_json({"type": "error", "code": "invalid_json", "message": "Invalid JSON"})
        except SignalingError as exc:
            try:
                await ws.send_json({"type": "error", "code": exc.code, "message": exc.message})
            except Exception:
                pass
            try:
                await ws.close(code=4403, reason=exc.code)
            except Exception:
                pass
        except (WebSocketDisconnect, json.JSONDecodeError):
            pass
        finally:
            if device is not None:
                hub.unregister_device(device.device_id, ws)

    @router.websocket("/ws/webrtc/client")
    async def webrtc_client_ws(
        ws: WebSocket,
        device_id: str = Query(default=""),
        token: str = Query(default=""),
    ):
        auth_token = token or ws.cookies.get(CLIENT_SESSION_COOKIE, "")
        try:
            session = hub.authenticate_client_ws(device_id=device_id, token=auth_token, ws=ws)
        except SignalingError as exc:
            await ws.close(code=4403 if exc.code == "unauthorized" else 4404, reason=exc.code)
            return

        await ws.accept()
        summary = hub.device_summary(device_id)
        await ws.send_json({
            "type": "client_ready",
            "session_id": session.session_id,
            "device_id": device_id,
            "device_name": summary["device_name"],
            "direct_only": True,
        })
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise SignalingError("invalid_payload", "JSON object required")
                    reply = await hub.forward_from_client(session, raw, data)
                    if reply is not None:
                        await ws.send_json(reply)
                except SignalingError as exc:
                    await ws.send_json({"type": "error", "code": exc.code, "message": exc.message})
                except json.JSONDecodeError:
                    await ws.send_json({"type": "error", "code": "invalid_json", "message": "Invalid JSON"})
        except WebSocketDisconnect:
            pass
        finally:
            hub.detach_client_ws(session.session_id, ws)

    return router
