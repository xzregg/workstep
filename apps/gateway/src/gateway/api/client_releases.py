from gateway.api.adapters import invoke
from gateway.services.client_releases import list_client_releases as _handle_list_client_releases, publish_client_release as _handle_publish_client_release, download_client_release as _handle_download_client_release


import os


from fastapi import APIRouter, Request


from gateway.services.client_releases import PublishReleaseInput

router = APIRouter(prefix="/api")


@router.get("/client-releases")
async def list_client_releases(request: Request, os: str | None = None, arch: str | None = None):
    return await invoke(_handle_list_client_releases, request=request, os=os, arch=arch)


@router.post("/admin/client-releases", status_code=201)
async def publish_client_release(request: Request, body: PublishReleaseInput):
    return await invoke(_handle_publish_client_release, request=request, body=body)


@router.get("/client-releases/{release_id}/download")
async def download_client_release(request: Request, release_id: str):
    return await invoke(_handle_download_client_release, request=request, release_id=release_id)
