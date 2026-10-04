"""The single ASGI boundary for service inputs, outputs and socket ports."""

from dataclasses import fields
from urllib.parse import urlsplit

from fastapi import Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse

from gateway.contracts import GatewayDependencies, GatewayCall, GatewaySocket, SocketClosed, ProofHeaders, QueryValues, ReplyEffects, JsonValue, RawValue, RedirectTarget, FileArtifact, StreamPayload


def gateway_call(request: Request) -> GatewayCall:
    state = getattr(request.scope.get("app"), "state", None)
    resource_fields = [item.name for item in fields(GatewayDependencies)]
    resources = {name: getattr(state, name) for name in resource_fields if hasattr(state, name)}
    return GatewayCall(
        **resources,
        tokens=dict(request.cookies), proofs=ProofHeaders(request.headers),
        target=urlsplit(str(request.url)), operation=getattr(request, "method", "GET"),
        peer=request.client, query_values=QueryValues(tuple(request.query_params.multi_items())),
        wire_headers=tuple(request.scope.get("headers", ())),
        payload=request.stream if isinstance(request, Request) else None,
        callback_url=lambda name, **params: str(request.url_for(name, **params)),
    )


class AsgiSocketPort:
    def __init__(self, socket: WebSocket):
        self.socket = socket

    async def accept(self, *, subprotocol=None):
        await self.socket.accept(subprotocol=subprotocol)

    async def close(self, code=1000, reason=None):
        await self.socket.close(code=code, reason=reason)

    async def receive_json(self):
        try:
            return await self.socket.receive_json()
        except WebSocketDisconnect as exc:
            raise SocketClosed() from exc

    async def send_json(self, value):
        await self.socket.send_json(value)

    async def receive(self):
        try:
            return await self.socket.receive()
        except WebSocketDisconnect as exc:
            raise SocketClosed() from exc

    async def send_text(self, value):
        await self.socket.send_text(value)

    async def send_bytes(self, value):
        await self.socket.send_bytes(value)


def gateway_socket(socket: WebSocket) -> GatewaySocket:
    call = gateway_call(socket)
    return GatewaySocket(**vars(call), port=AsgiSocketPort(socket))


def render_result(result, call: GatewayCall, response: Response | None = None, effects=None):
    if isinstance(result, JsonValue):
        output = JSONResponse(result.content)
    elif isinstance(result, RawValue):
        output = Response(result.content, media_type=result.media_type)
    elif isinstance(result, RedirectTarget):
        output = RedirectResponse(result.url, status_code=303)
    elif isinstance(result, FileArtifact):
        output = FileResponse(result.path, filename=result.filename, media_type=result.media_type)
    elif isinstance(result, StreamPayload):
        output = StreamingResponse(result.chunks, status_code=result.status)
    else:
        output = response
    grants = list(getattr(result, "grants", ()))
    if effects:
        grants.extend(effects.grants)
        if effects.phase:
            output.status_code = {"created": 201, "pending": 202}[effects.phase]
    if output is not None:
        headers = getattr(result, "headers", {})
        for name, value in headers.items():
            output.headers[name] = value
        for name, value in getattr(headers, "extra", ()):
            output.headers.append(name, value)
        for grant in grants:
            options = dict(path="/", secure=call.settings.cookie_secure, httponly=True, samesite="lax")
            if grant.token is None:
                output.delete_cookie(grant.key, **options)
            else:
                output.set_cookie(grant.key, grant.token, max_age=grant.lifetime, **options)
    return output if isinstance(result, (JsonValue, RawValue, RedirectTarget, FileArtifact, StreamPayload)) else result


async def invoke(operation, *, request=None, ws=None, response=None, **values):
    call = gateway_socket(ws) if ws is not None else gateway_call(request)
    values["ws" if ws is not None else "call"] = call
    effects = ReplyEffects()
    if response is not None:
        values["response"] = effects
    result = await operation(**values)
    return render_result(result, call, response, effects)
