import pytest
from gateway.services.workspace_paths import rewrite_workspace_html

@pytest.mark.asyncio
async def test_html_assets_and_base_are_scoped_across_chunks():
    async def chunks():
        yield b'<html><head><script src="/ass'
        yield b'ets/main.js"></script></head><body></body></html>'
    result=b''.join([chunk async for chunk in rewrite_workspace_html(chunks(), '/workspace/one/')])
    assert b'<base href="/workspace/one/">' in result
    assert b'src="/workspace/one/assets/main.js"' in result
