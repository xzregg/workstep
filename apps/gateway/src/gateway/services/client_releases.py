import asyncio

import base64

import hashlib

import json

import os

import re

from pathlib import Path

from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request

from fastapi.responses import FileResponse

from pydantic import BaseModel, Field, field_validator

from sqlalchemy import select

from sqlalchemy.exc import IntegrityError

from gateway.services.identity import COOKIE_NAME, IdentityService

from gateway.services.identity_api import _check_csrf

from gateway.models import ClientRelease


"""Immutable Gateway-specific Desktop installer registry."""


SAFE_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")


class PublishReleaseInput(BaseModel):
    os: str = Field(pattern=r"^(macos|windows|linux)$")
    arch: str = Field(pattern=r"^(arm64|x64)$")
    version: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
    filename: str
    minimum_protocol_version: int = Field(ge=1)

    @field_validator("filename")
    @classmethod
    def safe_filename(cls, value: str) -> str:
        if not SAFE_FILENAME.fullmatch(value) or value in {".", ".."}:
            raise ValueError("Invalid release filename")
        return value


def _copy_release(source: Path, published: Path, release_id: str) -> tuple[str, int, str]:
    if not source.is_file() or source.is_symlink():
        raise FileNotFoundError("Release file not found")
    published.mkdir(parents=True, exist_ok=True)
    storage_name = f"{release_id}{source.suffix}"
    temporary = published / f".{storage_name}.tmp"
    digest = hashlib.sha256()
    size = 0
    try:
        with source.open("rb") as input_file, temporary.open("xb") as output_file:
            for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
                output_file.write(chunk)
            output_file.flush()
            os.fsync(output_file.fileno())
        if size == 0:
            raise ValueError("Empty release file")
        os.replace(temporary, published / storage_name)
        return digest.hexdigest(), size, storage_name
    finally:
        temporary.unlink(missing_ok=True)


def _public(release: ClientRelease) -> dict:
    return {
        "id": release.id, "gateway_id": release.gateway_id,
        "os": release.os, "arch": release.arch, "version": release.version,
        "filename": release.filename, "file_size": release.file_size,
        "sha256": release.sha256, "signature": release.signature,
        "gateway_public_key_fingerprint": release.gateway_public_key_fingerprint,
        "minimum_protocol_version": release.minimum_protocol_version,
        "download_url": f"/api/client-releases/{release.id}/download",
    }



async def list_client_releases(request: Request, os: str | None = None, arch: str | None = None):
    database = request.app.state.database
    async with database.session() as session:
        query = select(ClientRelease).where(
            ClientRelease.gateway_id == request.app.state.settings.gateway_id,
            ClientRelease.status == "published",
        )
        if os:
            query = query.where(ClientRelease.os == os)
        if arch:
            query = query.where(ClientRelease.arch == arch)
        releases = (await session.scalars(query.order_by(ClientRelease.created_at.desc()))).all()
    return {"releases": [_public(release) for release in releases]}



async def publish_client_release(request: Request, body: PublishReleaseInput):
    token = request.cookies.get(COOKIE_NAME)
    identity = IdentityService(request.app.state.database)
    actor, auth_session = await identity.session_user(token)
    _check_csrf(request, token)
    await identity.require_super_admin(actor.id)
    await identity.require_step_up(auth_session)
    settings = request.app.state.settings
    release_id = uuid4().hex
    published = settings.data_dir / "releases" / "published"
    try:
        sha256, file_size, storage_name = await asyncio.to_thread(
            _copy_release, settings.data_dir / "releases" / body.filename,
            published, release_id,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    signed_payload = json.dumps({
        "gateway_id": settings.gateway_id, "os": body.os, "arch": body.arch,
        "version": body.version, "sha256": sha256, "file_size": file_size,
        "minimum_protocol_version": body.minimum_protocol_version,
    }, sort_keys=True, separators=(",", ":")).encode()
    signer = request.app.state.gateway_signer
    signature = base64.urlsafe_b64encode(signer.private_key.sign(signed_payload)).rstrip(b"=").decode()
    release = ClientRelease(
        id=release_id, gateway_id=settings.gateway_id, os=body.os, arch=body.arch,
        version=body.version, filename=body.filename, storage_name=storage_name,
        file_size=file_size, sha256=sha256, signature=signature,
        gateway_public_key_fingerprint=signer.fingerprint,
        minimum_protocol_version=body.minimum_protocol_version,
    )
    try:
        async with request.app.state.database.session() as session:
            async with session.begin():
                session.add(release)
    except IntegrityError as exc:
        await asyncio.to_thread((published / storage_name).unlink, missing_ok=True)
        raise HTTPException(status_code=409, detail="Release version already exists") from exc
    return _public(release)



async def download_client_release(request: Request, release_id: str):
    async with request.app.state.database.session() as session:
        release = await session.get(ClientRelease, release_id)
    if not release or release.gateway_id != request.app.state.settings.gateway_id or release.status != "published":
        raise HTTPException(status_code=404, detail="Release not found")
    path = request.app.state.settings.data_dir / "releases" / "published" / release.storage_name
    if not await asyncio.to_thread(path.is_file):
        raise HTTPException(status_code=404, detail="Release file missing")
    return FileResponse(path, filename=release.filename, media_type="application/octet-stream",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})
