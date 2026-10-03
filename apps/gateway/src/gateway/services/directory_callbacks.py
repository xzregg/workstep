import json

import os

import secrets

import time

from xml.etree import ElementTree

from fastapi import APIRouter, HTTPException, Request

from fastapi.responses import Response

from gateway.services.callback_crypto import CallbackCrypto, InvalidCallback

from gateway.services.external_identity import ExternalIdentityService


"""Authenticated DingTalk and WeCom directory event callbacks."""


MAX_CALLBACK_BYTES = 256 * 1024


DINGTALK_DIRECTORY_EVENTS = {
    "user_add_org", "user_modify_org", "user_leave_org", "user_active_org",
    "org_dept_create", "org_dept_modify", "org_dept_remove", "org_remove", "org_change",
}


async def _source_and_crypto(request: Request, source_id: str):
    source = await ExternalIdentityService(request.app.state.database).source(source_id)
    if not source.callback_token_env or not source.callback_aes_key_env:
        raise HTTPException(status_code=503, detail="Identity callback is not configured")
    token = os.environ.get(source.callback_token_env)
    aes_key = os.environ.get(source.callback_aes_key_env)
    if not token or not aes_key:
        raise HTTPException(status_code=503, detail="Identity callback secret is unavailable")
    owner = source.client_id if source.provider == "dingtalk" else source.tenant_id
    try:
        return source, CallbackCrypto(token=token, encoding_aes_key=aes_key, owner_key=owner)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Invalid identity callback configuration") from exc


async def _body(request: Request) -> bytes:
    body = bytearray()
    async for part in request.stream():
        body.extend(part)
        if len(body) > MAX_CALLBACK_BYTES:
            raise HTTPException(status_code=413, detail="Identity callback too large")
    return bytes(body)


def _decrypt(request: Request, crypto: CallbackCrypto, encrypted: str) -> bytes:
    query = request.query_params
    signature = query.get("msg_signature") or query.get("signature")
    timestamp = query.get("timestamp") or query.get("timeStamp")
    nonce = query.get("nonce")
    if (not signature or not timestamp or not nonce or len(signature) > 128
            or len(timestamp) > 32 or len(nonce) > 128 or len(encrypted) > MAX_CALLBACK_BYTES):
        raise HTTPException(status_code=400, detail="Invalid callback parameters")
    try:
        return crypto.decrypt(signature=signature, timestamp=timestamp, nonce=nonce,
                              encrypted=encrypted)
    except InvalidCallback as exc:
        raise HTTPException(status_code=403, detail="Identity callback verification failed") from exc


def _xml(data: bytes):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise HTTPException(status_code=400, detail="Invalid callback XML")
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError as exc:
        raise HTTPException(status_code=400, detail="Invalid callback XML") from exc



async def verify_wecom_callback(request: Request, source_id: str):
    source, crypto = await _source_and_crypto(request, source_id)
    if source.provider != "wecom":
        raise HTTPException(status_code=404, detail="Callback unavailable")
    echo = request.query_params.get("echostr")
    if not echo or len(echo) > MAX_CALLBACK_BYTES:
        raise HTTPException(status_code=400, detail="Invalid callback challenge")
    plain = _decrypt(request, crypto, echo)
    return Response(content=plain, media_type="text/plain")



async def receive_directory_callback(request: Request, source_id: str):
    source, crypto = await _source_and_crypto(request, source_id)
    body = await _body(request)
    if source.provider == "dingtalk":
        try:
            envelope = json.loads(body)
            encrypted = envelope["encrypt"]
            if not isinstance(encrypted, str):
                raise ValueError("Invalid encrypted payload")
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid DingTalk callback") from exc
        plain = _decrypt(request, crypto, encrypted)
        try:
            event = json.loads(plain)
            if not isinstance(event, dict) or not isinstance(event.get("EventType"), str):
                raise ValueError("Invalid event")
        except (ValueError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid DingTalk event") from exc
        if event.get("CorpId") not in (None, source.tenant_id):
            raise HTTPException(status_code=403, detail="Callback tenant mismatch")
        if event["EventType"] in DINGTALK_DIRECTORY_EVENTS:
            await ExternalIdentityService(request.app.state.database).enqueue_callback(source, plain)
            request.app.state.directory_callback_wake.set()
        return crypto.encrypt(b"success", timestamp=str(int(time.time())),
                              nonce=secrets.token_urlsafe(12))

    envelope = _xml(body)
    encrypted = envelope.findtext("Encrypt")
    if not encrypted:
        raise HTTPException(status_code=400, detail="Invalid WeCom callback")
    plain = _decrypt(request, crypto, encrypted)
    event = _xml(plain)
    if event.findtext("Event") == "change_contact":
        await ExternalIdentityService(request.app.state.database).enqueue_callback(source, plain)
        request.app.state.directory_callback_wake.set()
    return Response(status_code=200)
