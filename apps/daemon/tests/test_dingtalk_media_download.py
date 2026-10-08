from unittest.mock import AsyncMock

import pytest
from services.channels.base import ChannelAttachment
from services.channels.dingtalk import DingTalkAdapter
from services.channels.media import fetch_media


@pytest.mark.parametrize('kind,name', [('image', 'photo.jpg'), ('file', 'report.pdf')])
async def test_dingtalk_media_uses_https_even_for_legacy_download_url(monkeypatch, kind, name):
    urls = []
    class Content:
        async def iter_chunked(self, size): yield b'media'
    class Response:
        status = 200
        headers = {}
        content = Content()
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def raise_for_status(self): pass
        async def json(self): return {'downloadUrl': 'http://static.dingtalk.com/media/item?signature=keep%2Bme'}
    class Session:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def post(self, *args, **kwargs): return Response()
        def get(self, url, **kwargs):
            urls.append(url)
            assert kwargs['allow_redirects'] is False
            return Response()
    monkeypatch.setattr('services.channels.dingtalk.aiohttp.ClientSession', Session)
    adapter = DingTalkAdapter({'id': 'b', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._token = AsyncMock(return_value='token')
    attachment = ChannelAttachment(kind=kind, name=name, reference={'download_code': 'code'})
    assert await adapter.download(attachment) == (b'media', name)
    assert urls == ['https://static.dingtalk.com/media/item?signature=keep%2Bme']


async def test_dingtalk_redirect_is_upgraded_and_external_redirect_rejected(monkeypatch):
    urls = []
    class Content:
        async def iter_chunked(self, size): yield b'body'
    class Response:
        content = Content()
        def __init__(self, target=None):
            self.status = 302 if target else 200
            self.headers = {'Location': target} if target else {}
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def raise_for_status(self): pass
    targets = ['http://cdn.alicdn.com/file', None]
    class Session:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def get(self, url, **kwargs):
            urls.append(url)
            return Response(targets.pop(0))
    monkeypatch.setattr('services.channels.media.aiohttp.ClientSession', Session)
    assert await fetch_media('https://static.dingtalk.com/file', 10, ('dingtalk.com', 'alicdn.com'), upgrade_http=True) == b'body'
    assert urls[-1] == 'https://cdn.alicdn.com/file'
    targets[:] = ['http://127.0.0.1/secret']
    with pytest.raises(ValueError, match='HTTPS'):
        await fetch_media('https://static.dingtalk.com/file', 10, ('dingtalk.com',), upgrade_http=True)
    assert 'http://127.0.0.1/secret' not in urls


@pytest.mark.parametrize('url', ['http://dingtalk.com.evil.test/file', 'http://127.0.0.1/file', 'https://evil.test/file'])
async def test_media_rejects_untrusted_hosts_before_download(url):
    with pytest.raises(ValueError, match='HTTPS'):
        await fetch_media(url, 10, ('dingtalk.com',), upgrade_http=True)
