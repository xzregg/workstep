import asyncio
import hashlib
import time

import httpx
import pytest

from services.speech import SpeechService
from services.tts_resources import TtsResources
from services.resource_download import ResourceDownload


@pytest.mark.asyncio
@pytest.mark.parametrize('honors_range', [True, False])
@pytest.mark.parametrize('network_error', [True, False])
async def test_interrupted_download_continues_after_reopening_cache(tmp_path, honors_range, network_error, monkeypatch):
    data = b'model weights'
    digest = hashlib.sha256(data).hexdigest()
    cache = ResourceDownload(tmp_path, 'model')
    reached = asyncio.Event()

    class Interrupted(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield data[:5]
            reached.set()
            if network_error:
                raise httpx.ReadError('connection interrupted')
            await asyncio.Future()

    def resume(request):
        assert request.headers['range'] == 'bytes=5-'
        if not honors_range:
            return httpx.Response(200, content=data)
        return httpx.Response(206, content=data[5:], headers={'Content-Range': f'bytes 5-{len(data) - 1}/{len(data)}'})

    url = 'https://example.test/model'
    state = {'downloaded_bytes': 0}
    original_append = cache.append

    def slow_append(path, chunk):
        time.sleep(.12)
        original_append(path, chunk)

    monkeypatch.setattr(cache, 'append', slow_append)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=Interrupted()))) as client:
        job = asyncio.create_task(cache.fetch(client, url, cache.stage / 'model.onnx', len(data), digest, state))
        await asyncio.sleep(.02)
        assert not reached.is_set() and not job.done()
        await asyncio.wait_for(reached.wait(), .5)
        if not network_error:
            job.cancel()
        with pytest.raises(httpx.ReadError if network_error else asyncio.CancelledError):
            await job

    reopened = ResourceDownload(tmp_path, 'model')
    assert reopened.cached_bytes() == 5
    state['downloaded_bytes'] = 0
    async with httpx.AsyncClient(transport=httpx.MockTransport(resume)) as client:
        await reopened.fetch(client, url, reopened.stage / 'model.onnx', len(data), digest, state)
    assert (reopened.stage / 'model.onnx').read_bytes() == data
    assert state['downloaded_bytes'] == len(data)


@pytest.mark.asyncio
async def test_clearing_saved_download_keeps_installed_model_and_other_downloads(tmp_path):
    speech = SpeechService(tmp_path / 'speech')
    tts = TtsResources(tmp_path / 'tts')
    for root, model_id, discard in [
        (speech.root, speech.model_id, lambda model_id: speech.delete(model_id, partial_only=True)),
        (tts.root, 'kokoro-v1', lambda model_id: tts.delete(model_id, partial_only=True)),
    ]:
        cache = ResourceDownload(root, model_id)
        cache.folder.mkdir(parents=True)
        (cache.folder / 'weights.part').write_bytes(b'abcd')
        other = ResourceDownload(root, 'another-model')
        other.folder.mkdir(parents=True)
        (other.folder / 'weights.part').write_bytes(b'abc')
        installed = root / model_id
        installed.mkdir()
        (installed / 'model.onnx').write_bytes(b'model')
        await discard(model_id)
        assert cache.cached_bytes() == 0
        assert other.cached_bytes() == 3
        assert (installed / 'model.onnx').read_bytes() == b'model'
