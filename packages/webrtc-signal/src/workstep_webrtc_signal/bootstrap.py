"""Only the connection bootstrap is served by signaling; the host owns the UI."""
from pathlib import Path
import asyncio

from fastapi import HTTPException
from fastapi.responses import FileResponse


def install_bootstrap_routes(app, web_dist: Path | None):
    root = web_dist / 'rtc-bootstrap' if web_dist else None

    async def response(filename):
        if root is None or not await asyncio.to_thread((root / filename).is_file):
            raise HTTPException(503, 'WebRTC connection page is unavailable')
        # Fixed filenames only; never expose the workbench tree via this route.
        return FileResponse(root / filename, headers={'Cache-Control': 'no-store'})

    @app.get('/p2p/rtc-worker.js', include_in_schema=False)
    async def worker():
        return await response('worker.js')

    @app.get('/p2p-bootstrap/{filename}', include_in_schema=False)
    async def asset(filename: str):
        if filename not in {'bootstrap.js','style.css'}:
            raise HTTPException(404)
        return await response(filename)

    @app.get('/p2p/{device_id}', include_in_schema=False)
    @app.get('/p2p/{device_id}/{fullpath:path}', include_in_schema=False)
    async def entry(device_id: str, fullpath: str = ''):
        import re
        if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}',device_id) or fullpath.startswith(('__host/','assets/','api/','workspace-assets/')):
            raise HTTPException(404)
        return await response('index.html')
