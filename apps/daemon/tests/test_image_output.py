"""Generated images become durable Markdown shared by chat and channels."""
import asyncio
import base64
import io
import threading
from pathlib import Path
from types import SimpleNamespace as N
from unittest.mock import AsyncMock

import pytest

from engines.codex_sdk import CodexSDKEngine
from engines.core.events import InternalEvent


def png():
    from PIL import Image
    stream = io.BytesIO()
    Image.new('RGB', (32, 24), 'orange').save(stream, 'PNG')
    return stream.getvalue()


def image_event(data, kind='imageGeneration', status='completed'):
    return InternalEvent('acp_raw', {'method': 'item/completed', 'raw': {
        'item': {'type': kind, 'id': 'image-1', 'status': status,
                 'result': base64.b64encode(data).decode()}}})


@pytest.mark.parametrize('entry', ['spawn_with_retry', 'spawn_coordinator_with_retry'])
async def test_generated_image_stream_is_persisted_and_sendable(tmp_path, entry):
    data = png()
    class Engine(CodexSDKEngine):
        async def spawn(self, **kwargs):
            yield image_event(data)
            yield image_event(data)  # repeated completion must not duplicate attachments
            yield InternalEvent('agent_message_chunk', {'content': {'text': '画好了'}, 'phase': 'final_answer'})
        spawn_coordinator = spawn
    events = [e async for e in getattr(Engine(), entry)(cwd=str(tmp_path), prompt='画猫')]
    text = ''.join(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')
    assert text.count('![') == 1
    assert '画好了' in text
    assert base64.b64encode(data).decode() not in str([e.data for e in events])
    from services.channels.media import outgoing_content
    from services.channels.wecom import WeComAdapter
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    message = await outgoing_content(N(path=tmp_path, workstep_dir=tmp_path/'.workstep'), adapter, text)
    assert message.attachments[0].data == data
    assert message.attachments[0].kind == 'image'
    assert '.workstep/' not in message.text


@pytest.mark.parametrize('shape', ['acp', 'mcp', 'claude', 'cli'])
async def test_common_image_shapes_use_same_storage(tmp_path, shape):
    from engines.core.image_output import ImageOutputNormalizer
    data = png()
    block = {'type': 'image', 'data': base64.b64encode(data).decode(), 'mimeType': 'image/png'}
    if shape == 'claude':
        block = {'type': 'image', 'source': {'type': 'base64', 'data': block['data'], 'media_type': 'image/png'}}
    if shape == 'acp':
        event = InternalEvent('agent_message_chunk', {'content': block})
    elif shape == 'cli':
        event = image_event(data, 'image_generation')
    else:
        event = InternalEvent('tool_call_update', {'tool_call_id': 't', 'status': 'completed', 'raw_output': {'content': [block]}})
    events = await ImageOutputNormalizer(tmp_path/'.workstep', tmp_path).normalize(event)
    assert any(e.type == 'agent_message_chunk' and '![' in e.data['content']['text'] for e in events)
    assert len(list((tmp_path/'.workstep/uploads').glob('*.png'))) == 1


async def test_invalid_and_failed_images_do_not_claim_success(tmp_path):
    from engines.core.image_output import ImageOutputNormalizer
    normalizer = ImageOutputNormalizer(tmp_path/'.workstep', tmp_path)
    events = await normalizer.normalize(image_event(b'not an image'))
    assert not any('![' in e.data.get('content', {}).get('text', '') for e in events)
    assert any('图片' in e.data.get('content', {}).get('text', '') for e in events)
    failed = await normalizer.normalize(image_event(png(), status='failed'))
    assert not any('![' in e.data.get('content', {}).get('text', '') for e in failed)


async def test_external_storage_and_symlink_protection(tmp_path):
    from engines.core.image_output import ImageOutputNormalizer
    external = tmp_path/'external'
    root = tmp_path/'project'; root.mkdir()
    events = await ImageOutputNormalizer(external, root).normalize(image_event(png()))
    text = next(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')
    from services.channels.media import outgoing_content
    from services.channels.wecom import WeComAdapter
    adapter = WeComAdapter({'id': 'b'}, AsyncMock(), AsyncMock())
    outgoing = await outgoing_content(N(path=root, workstep_dir=external), adapter, text)
    assert outgoing.attachments[0].data == png()
    other = tmp_path/'other'; other.mkdir()
    (other/'uploads').symlink_to(root, target_is_directory=True)
    rejected = await ImageOutputNormalizer(other, root).normalize(image_event(png()))
    assert not any('![' in e.data.get('content', {}).get('text', '') for e in rejected)
    assert not list(root.glob('*.png'))


async def test_image_disk_io_does_not_block_health(tmp_path, monkeypatch):
    from engines.core.image_output import ImageOutputNormalizer
    from httpx import ASGITransport, AsyncClient
    import main
    entered, release = threading.Event(), threading.Event()
    original = ImageOutputNormalizer._save
    def slow(self, *args):
        entered.set()
        assert release.wait(3)
        return original(self, *args)
    monkeypatch.setattr(ImageOutputNormalizer, '_save', slow)
    task = asyncio.create_task(ImageOutputNormalizer(tmp_path/'.workstep', tmp_path).normalize(image_event(png())))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
    assert await task


async def test_channel_compresses_copy_without_changing_original(tmp_path):
    from PIL import Image
    from services.channels.media import load_outgoing_attachment
    stream = io.BytesIO()
    Image.effect_noise((1600, 1000), 100).convert('RGB').save(stream, 'PNG')
    data = stream.getvalue()
    target = tmp_path/'large.png'; target.write_bytes(data)
    result = await load_outgoing_attachment(N(path=tmp_path), 'image', 'large.png', 120_000)
    assert len(result.data) <= 120_000
    assert result.mime_type == 'image/jpeg'
    assert result.name.endswith('.jpg')
    assert target.read_bytes() == data
    with Image.open(io.BytesIO(result.data)) as image:
        image.verify()


@pytest.mark.parametrize('engine_id', ['claude_code', 'claude_agent_sdk', 'qoder_sdk', 'codex_sdk', 'acp'])
async def test_adapter_preserves_native_image_until_shared_conversion(tmp_path, engine_id):
    from engines.core.image_output import ImageOutputNormalizer
    block = {'type': 'image', 'data': base64.b64encode(png()).decode(), 'mimeType': 'image/png'}
    if engine_id == 'acp':
        from acp import schema
        from engines.core.acp_event_mapper import ACPEventMapper
        events = [ACPEventMapper()._map_notification(schema.AgentMessageChunk(
            session_update='agent_message_chunk', content=schema.ImageContentBlock(**block))) ]
    elif engine_id == 'codex_sdk':
        events = CodexSDKEngine()._map_notification(N(method='item/completed', payload=N(item=N(root=N(
            type='mcpToolCall', id='image-tool', status='completed', result={'content': [block]}, error=None,
        )))), {})
    elif engine_id == 'claude_code':
        from engines.claude_code import ClaudeCodeEngine
        events = ClaudeCodeEngine()._map_events({'type': 'user', 'message': {'content': [
            {'type': 'tool_result', 'tool_use_id': 't', 'content': [block]}]}})
    else:
        from engines.claude_agent_sdk import ClaudeAgentSDKEngine
        from engines.qoder_sdk import QoderSDKEngine
        engine = ClaudeAgentSDKEngine() if engine_id == 'claude_agent_sdk' else QoderSDKEngine()
        events = engine._map_message(N(type='user', content=[N(type='tool_result', tool_use_id='t', content=[block], is_error=False)]))
    normalizer = ImageOutputNormalizer(tmp_path/'.workstep', tmp_path)
    output = []
    for event in events:
        output.extend(await normalizer.normalize(event))
    assert any('![' in event.data.get('content', {}).get('text', '') for event in output)


async def test_generated_image_is_served_and_sent_as_weixin_image(tmp_path, monkeypatch, preview_directory):
    from engines.core.image_output import ImageOutputNormalizer
    from services.channels.media import outgoing_content
    from services.channels.weixin import WeixinAdapter
    from services.channels.base import IncomingMessage
    from httpx import ASGITransport, AsyncClient
    import main
    project = N(path=tmp_path, workstep_dir=tmp_path/'.workstep', id='project')
    events = await ImageOutputNormalizer(project.workstep_dir, tmp_path).normalize(image_event(png()))
    text = events[-1].data['content']['text']
    monkeypatch.setattr(main, 'project_manager', N(get_project_by_id=lambda pid: project))
    filename = next((project.workstep_dir/'uploads').iterdir()).name
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
        response = await client.get('/api/fs/serve/' + filename, params={'project_id': project.id})
        assert response.status_code == 200
        assert response.content == png()
        assert response.headers['content-type'] == 'image/png'
    adapter = WeixinAdapter({'id': 'b', 'app_id': 'account', 'secret': 'test', 'weixin_user_id': 'u'}, AsyncMock(), AsyncMock())
    upload = AsyncMock(return_value={'type': 2, 'image_item': {'media': {'encrypt_query_param': 'test'}}})
    monkeypatch.setattr('services.channels.weixin.weixin_media.upload', upload)
    adapter._send_items = AsyncMock()
    recipient = IncomingMessage('b', 'm', 'single', 'u', 'u', '', reply_context={'context_token': 'test'})
    await adapter.send(recipient, await outgoing_content(project, adapter, text))
    assert upload.await_args.args[2].data == png()
    assert adapter._send_items.await_args.args[1][0]['type'] == 2


async def test_duplicate_acp_image_has_one_message(tmp_path):
    from engines.core.image_output import ImageOutputNormalizer
    normalizer = ImageOutputNormalizer(tmp_path/'.workstep', tmp_path)
    event = InternalEvent('agent_message_chunk', {'content': {
        'type': 'image', 'data': base64.b64encode(png()).decode(), 'mimeType': 'image/png'}})
    assert len(await normalizer.normalize(event)) == 1
    assert await normalizer.normalize(event) == []
