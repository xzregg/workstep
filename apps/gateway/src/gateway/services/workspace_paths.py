"""Adapt the small Web entry document to a device path; data streams stay untouched."""
from gateway.services.errors import GatewayError

async def rewrite_workspace_html(chunks, prefix: str):
    content = bytearray()
    async for chunk in chunks:
        content.extend(chunk)
        if len(content) > 1024 * 1024:
            raise GatewayError('upstream_failed', 'Workspace entry document too large')
    document = content.decode('utf-8')
    document = document.replace('<head>', '<head><base href="' + prefix + '">', 1)
    document = document.replace('"/assets/', '"' + prefix + 'assets/').replace("'/assets/", "'" + prefix + 'assets/')
    yield document.encode('utf-8')
