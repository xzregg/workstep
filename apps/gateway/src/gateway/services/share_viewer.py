"""Serve the canonical WorkStep task viewer with Gateway visitor transport."""
import asyncio
import re
from fastapi import HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles


def install_share_viewer(app, settings):
    root = settings.workspace_web_dist
    if root is not None:
        app.mount('/workspace-assets', StaticFiles(directory=root, check_dir=False), name='share-viewer-assets')

    @app.get('/share/{token}', include_in_schema=False)
    async def share_viewer(token: str):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', token):
            raise HTTPException(status_code=404)
        if root is None:
            raise HTTPException(status_code=503, detail='WorkStep share viewer build is unavailable')
        try:
            html = await asyncio.to_thread((root / 'index.html').read_text, encoding='utf-8')
        except OSError as exc:
            raise HTTPException(status_code=503, detail='WorkStep share viewer build is unavailable') from exc
        # The dedicated build uses /workspace-assets for its lazy chunks too.
        html = html.replace('</head>', '<meta name="workstep-share-transport" content="gateway"></head>')
        return HTMLResponse(html, headers={'Cache-Control': 'no-store'})
