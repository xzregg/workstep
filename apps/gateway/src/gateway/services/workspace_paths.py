"""Adapt the small Web entry document to a device path; data streams stay untouched."""
import hashlib
import re

from gateway.services.errors import GatewayError

async def rewrite_workspace_html(chunks, prefix: str):
    content = bytearray()
    async for chunk in chunks:
        content.extend(chunk)
        if len(content) > 1024 * 1024:
            raise GatewayError('upstream_failed', 'Workspace entry document too large')
    document = content.decode('utf-8')
    document = document.replace('<head>', '<head><base href="' + prefix + '">', 1)
    # Escape partial responses previously cached under an unversioned workspace URL.
    revision = hashlib.sha256(content).hexdigest()[:16]
    def asset_url(match):
        quote, url = match.groups()
        path, separator, fragment = url.partition('#')
        query_separator = '&amp;' if '?' in path else '?'
        path = prefix.rstrip('/') + path + query_separator + '_workstep_asset=' + revision
        return quote + path + (separator + fragment if separator else '') + quote
    document = re.sub(r"([\"'])(/assets/[^\"'<>]+)\1", asset_url, document)
    yield document.encode('utf-8')


def is_workspace_document(method: str, path: str, headers) -> bool:
    return method == 'GET' and not path.startswith(('/api/', '/assets/')) and (
        path == '/' or headers.get('sec-fetch-dest') == 'document'
        or 'text/html' in headers.get('accept', '').lower())
