"""ClawBot direct iLink transport, QR credentials and nonblocking lifecycle."""
import asyncio
import json
import threading
from unittest.mock import AsyncMock

import httpx
import pytest

from services.channels.base import IncomingMessage, OutgoingMessage, ChannelAttachment
from services.channels.registry import discover_channels
from tests.test_channel_bots import bots


def adapter(tmp_path, **kwargs):
    from services.channels.weixin import WeixinAdapter
    channel = WeixinAdapter({'id': 'b', 'app_id': 'account', 'secret': 'private-token',
                             'weixin_user_id': 'owner'}, AsyncMock(), AsyncMock())
    channel._state.path = tmp_path / 'state.json'
    return channel


async def test_weixin_direct_http_headers_and_context_reply(tmp_path):
    channel = adapter(tmp_path)
    calls = []
    def request(request):
        calls.append(request)
        assert request.url.host == 'ilinkai.weixin.qq.com'
        assert request.headers['authorization'] == 'Bearer private-token'
        assert request.headers['authorizationtype'] == 'ilink_bot_token'
        return httpx.Response(200, json={'ret': 0})
    channel._api.http = httpx.AsyncClient(transport=httpx.MockTransport(request))
    try:
        await channel.send_text(IncomingMessage('b', 'm', 'single', 'owner', 'owner', '',
                                reply_context={'context_token': 'context'}), '你好')
        body = json.loads(calls[0].content)
        assert body['msg']['context_token'] == 'context'
        assert body['msg']['message_type'] == 2
        assert body['msg']['item_list'] == [{'type': 1, 'text_item': {'text': '你好'}}]
        assert body['base_info']['channel_version']
        with pytest.raises(ValueError, match='私聊'):
            await channel.send_text(IncomingMessage('b', '', 'group', 'g', 'owner', ''), '群')
    finally:
        await channel.stop()


async def test_weixin_incoming_identity_quote_media_and_owner_isolation(tmp_path):
    channel = adapter(tmp_path)
    frame = {'message_id': 123, 'from_user_id': 'owner', 'message_type': 1,
             'context_token': 'context', 'item_list': [
                 {'type': 1, 'text_item': {'text': '查看'}, 'ref_msg': {'title': '原问题'}},
                 {'type': 2, 'image_item': {'media': {'encrypt_query_param': 'opaque', 'aes_key': 'key'}}},
             ]}
    await channel._handle_message(frame)
    await channel._drain_messages()
    message = channel._on_message.await_args.args[0]
    assert message.message_id == '123' and message.text == '查看'
    assert message.conversation_type == 'single' and message.sender_id == 'owner'
    assert message.quote.text == '原问题'
    assert message.attachments[0].kind == 'image'
    assert message.reply_context == {'context_token': 'context'}
    await channel._handle_message({**frame, 'from_user_id': 'stranger'})
    await channel._handle_message({**frame, 'message_type': 2})
    await channel._drain_messages()
    assert channel._on_message.await_count == 1
    restored = adapter(tmp_path)
    await restored._state.load()
    assert restored._state.tokens['owner'] == 'context'


async def test_weixin_qr_lifecycle_never_returns_token_and_checks_redirects():
    from services.channels.weixin_login import WeixinLogin
    login = WeixinLogin()
    login.api.request = AsyncMock(side_effect=[
        {'qrcode': 'opaque-qr', 'qrcode_img_content': 'https://liteapp.weixin.qq.com/login?id=qr'},
        {'status': 'scaned'},
        {'status': 'confirmed', 'bot_token': 'private-token', 'ilink_bot_id': 'account',
         'ilink_user_id': 'owner', 'baseurl': 'https://ilinkai.weixin.qq.com'},
    ])
    first = await login.start()
    assert first['qr_content'].startswith('https://liteapp.')
    assert (await login.poll(first['login_id']))['status'] == 'scaned'
    confirmed = await login.poll(first['login_id'])
    assert confirmed['status'] == 'confirmed' and confirmed['account_id'] == 'account'
    assert 'private-token' not in json.dumps(confirmed)
    assert login.credentials(first['login_id'])['secret'] == 'private-token'
    login.consume(first['login_id'])
    with pytest.raises(ValueError):
        login.credentials(first['login_id'])
    login.api.request = AsyncMock(side_effect=[{'qrcode': 'qr', 'qrcode_img_content': 'content'},
        {'status': 'scaned_but_redirect', 'redirect_host': '127.0.0.1'}])
    first = await login.start()
    with pytest.raises(ValueError, match='地址'):
        await login.poll(first['login_id'])
    await login.close()


async def test_weixin_expired_session_stops_polling_and_slow_network_does_not_block_health(tmp_path):
    import main
    channel = adapter(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    async def request(request):
        entered.set()
        await release.wait()
        return httpx.Response(200, json={'ret': -14, 'errmsg': 'private-token'})
    channel._api.http = httpx.AsyncClient(transport=httpx.MockTransport(request))
    await channel.start()
    try:
        await asyncio.wait_for(entered.wait(), 1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        release.set()
        await asyncio.wait_for(channel._task, 1)
        assert channel._on_state.await_args.args[0] == 'error'
        assert '扫码' in channel._on_state.await_args.args[1]
        assert 'private-token' not in str(channel._on_state.await_args_list)
    finally:
        release.set()
        await channel.stop()


async def test_weixin_slow_state_write_is_offloaded(tmp_path, monkeypatch):
    import main
    channel = adapter(tmp_path)
    entered, release = threading.Event(), threading.Event()
    original = channel._state._write
    def slow(value):
        entered.set()
        assert release.wait(2)
        original(value)
    monkeypatch.setattr(channel._state, '_write', slow)
    pending = asyncio.create_task(channel._state.save())
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
        await pending


@pytest.mark.parametrize('operation', ['encrypt', 'decrypt'])
async def test_weixin_slow_media_crypto_does_not_block_health(tmp_path, monkeypatch, operation):
    import base64
    import main
    from services.channels import weixin_media
    channel = adapter(tmp_path)
    key = bytes(range(16))
    ciphertext = weixin_media.encrypt(b'hello', key)
    entered, release = threading.Event(), threading.Event()
    loop_thread = threading.get_ident()
    original = getattr(weixin_media, operation)
    def slow(*args):
        assert threading.get_ident() != loop_thread
        entered.set()
        assert release.wait(2)
        return original(*args)
    monkeypatch.setattr(weixin_media, operation, slow)
    channel._api.request = AsyncMock(return_value={'upload_param': 'upload'})
    channel._api.http = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=ciphertext, headers={'x-encrypted-param': 'download'})))
    if operation == 'encrypt':
        work = channel.send(IncomingMessage('b', 'm', 'single', 'owner', 'owner', ''),
            OutgoingMessage(attachments=(ChannelAttachment('file', 'report.txt', data=b'hello'),)))
    else:
        work = channel.download(ChannelAttachment('file', 'report.txt', reference={
            'encrypt_query_param': 'download', 'aes_key': base64.b64encode(key).decode()}))
    pending = asyncio.create_task(work)
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        assert not pending.done()
    finally:
        release.set()
        try:
            await pending
        finally:
            await channel.stop()


async def test_weixin_qr_receipt_creates_bot_via_real_api_and_routes_existing_chat(bots):
    import main
    manager, project, _, _, chats, _ = bots
    instances = {}
    def factory(bot, on_message, on_state):
        channel = discover_channels()['weixin'](bot, on_message, on_state)
        channel.start = AsyncMock()
        channel._api.request = AsyncMock(return_value={'ret': 0})
        instances[bot['id']] = channel
        return channel
    manager._factories['weixin'] = factory
    manager.weixin_login.api.request = AsyncMock(side_effect=[
        {'qrcode': 'qr', 'qrcode_img_content': 'scan-me'},
        {'status': 'confirmed', 'bot_token': 'private-token', 'ilink_bot_id': 'account', 'ilink_user_id': 'owner'},
    ])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
        started = (await client.post('/api/channel-bots/weixin/login', json={})).json()
        receipt = (await client.get('/api/channel-bots/weixin/login/' + started['login_id'])).json()
        response = await client.post('/api/channel-bots', json={'platform': 'weixin', 'name': '微信助手',
            'login_id': receipt['login_id'], 'enabled': True, 'default_project_id': project.id})
        assert response.status_code == 200, response.text
        bot = response.json()
        assert bot['has_secret'] and 'private-token' not in response.text
        assert not bot['capabilities']['cards'] and bot['capabilities']['streaming']
        assert 'weixin_user_id' not in bot
        assert 'private-token' not in (await client.get('/api/channel-bots')).text
        channel = instances[bot['id']]
        frame = {'message_id': 1, 'message_type': 1, 'from_user_id': 'owner', 'context_token': 'ctx',
                 'item_list': [{'type': 1, 'text_item': {'text': '你好'}}]}
        await channel._handle_message(frame)
        await channel._drain_messages()
        await channel._handle_message(frame)
        await channel._drain_messages()
        assert len(chats) == 1
        await manager.save_private_whitelist(bot['id'], True, [])
        await channel._handle_message({**frame, 'message_id': 2})
        await channel._drain_messages()
        assert len(chats) == 1
        invalid = await client.post('/api/channel-bots', json={'platform': 'weixin', 'name': '伪造',
            'app_id': 'other', 'secret': 'token', 'default_project_id': project.id})
        assert invalid.status_code in (400, 422)


async def test_weixin_qr_poll_returns_before_gateway_deadline_and_resumes(bots, monkeypatch):
    import main
    from services.channels import weixin_login
    manager, *_ = bots
    # Scale the deadline down while using the real route and a blocked upstream.
    monkeypatch.setattr(weixin_login, 'POLL_WAIT_SECONDS', .02, raising=False)
    login = manager.weixin_login
    login.api.request = AsyncMock(return_value={'qrcode': 'qr', 'qrcode_img_content': 'scan-me'})
    entered, cancelled = asyncio.Event(), asyncio.Event()
    async def slow(*args, **kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
        receipt = (await client.post('/api/channel-bots/weixin/login', json={})).json()
        path = '/api/channel-bots/weixin/login/' + receipt['login_id']
        login.api.request = AsyncMock(return_value={'status': 'scaned'})
        assert (await client.get(path)).json()['status'] == 'scaned'
        login.api.request = slow
        pending = asyncio.create_task(client.get(path))
        await asyncio.wait_for(entered.wait(), .5)
        assert (await client.get('/api/health')).status_code == 200
        response = await asyncio.wait_for(pending, .5)
        assert response.status_code == 200
        assert response.json()['status'] == 'scaned'
        assert cancelled.is_set()
        login.api.request = AsyncMock(return_value={'status': 'confirmed', 'bot_token': 'private-token',
            'ilink_bot_id': 'account', 'ilink_user_id': 'owner'})
        confirmed = await client.get(path)
        assert confirmed.json()['status'] == 'confirmed'
        assert 'private-token' not in confirmed.text


async def test_weixin_media_roundtrip_and_untrusted_url_rejection(tmp_path):
    from services.channels.weixin_media import encrypt, decrypt, media_url
    key = bytes(range(16))
    assert decrypt(encrypt(b'picture', key), key) == b'picture'
    for url in ('http://127.0.0.1/file', 'https://evil.example/file', 'https://novac2c.cdn.weixin.qq.com@evil.example/f'):
        with pytest.raises(ValueError):
            media_url({'full_url': url})
    channel = adapter(tmp_path)
    channel._api.request = AsyncMock(return_value={'upload_param': 'upload'})
    requests = []
    def request(request):
        requests.append(request)
        return httpx.Response(200, headers={'x-encrypted-param': 'download'})
    channel._api.http = httpx.AsyncClient(transport=httpx.MockTransport(request))
    try:
        await channel.send(IncomingMessage('b', 'm', 'single', 'owner', 'owner', ''),
            OutgoingMessage(attachments=(ChannelAttachment('file', 'report.txt', data=b'hello'),)))
        assert requests[0].url.host == 'novac2c.cdn.weixin.qq.com'
        assert 'authorization' not in requests[0].headers
        body = channel._api.request.await_args.kwargs['payload']['msg']
        assert body['item_list'][0]['file_item']['file_name'] == 'report.txt'
    finally:
        await channel.stop()


async def test_weixin_restart_cursor_typing_and_cancellation(tmp_path):
    channel = adapter(tmp_path)
    channel._state.cursor = 'saved-cursor'
    channel._state.tokens = {'owner': 'saved-context'}
    await channel._state.save()
    restored = adapter(tmp_path)
    entered = asyncio.Event()
    async def request(endpoint, **kwargs):
        if endpoint == 'getupdates':
            assert kwargs['payload']['get_updates_buf'] == 'saved-cursor'
            entered.set()
            await asyncio.Event().wait()
        if endpoint == 'getconfig':
            return {'typing_ticket': 'ticket'}
        return {}
    restored._api.request = AsyncMock(side_effect=request)
    await restored.start()
    await asyncio.wait_for(entered.wait(), 1)
    message = IncomingMessage('b', 'm', 'single', 'owner', 'owner', '')
    await restored.start_reply(message)
    await asyncio.sleep(.01)
    await asyncio.wait_for(restored.stop(), 1)
    configs = [call.kwargs['payload'] for call in restored._api.request.await_args_list if call.args[0] == 'getconfig']
    assert configs[0]['context_token'] == 'saved-context'
    statuses = [call.kwargs['payload']['status'] for call in restored._api.request.await_args_list if call.args[0] == 'sendtyping']
    assert statuses == [1, 2]
    assert not restored._typing and restored._task is None


async def test_weixin_qr_expiry_cancellation_and_same_bot_receipt():
    from services.channels.weixin_login import WeixinLogin
    login = WeixinLogin()
    login.api.request = AsyncMock(side_effect=[
        {'qrcode': 'qr', 'qrcode_img_content': 'scan'}, {'status': 'expired'},
        {'qrcode': 'qr2', 'qrcode_img_content': 'scan2'},
        {'status': 'confirmed', 'ilink_bot_id': 'a', 'ilink_user_id': 'u', 'bot_token': 'private'},
    ])
    first = await login.start()
    assert (await login.poll(first['login_id']))['status'] == 'expired'
    with pytest.raises(ValueError):
        login.credentials(first['login_id'])
    second = await login.start('bot')
    await login.poll(second['login_id'])
    with pytest.raises(ValueError):
        login.credentials(second['login_id'], 'other')
    assert login.credentials(second['login_id'], 'bot')['secret'] == 'private'
    login._sessions[second['login_id']]['expires'] = 0
    with pytest.raises(ValueError, match='失效'):
        login.credentials(second['login_id'], 'bot')
    await login.close()


async def test_weixin_api_timeout_redaction_and_qr_redirect():
    from services.channels.weixin_api import ILinkClient, api_url
    assert api_url('https://ilinkai2.weixin.qq.com/') == 'https://ilinkai2.weixin.qq.com'
    for value in ('https://ilinkai.weixin.qq.com.evil.org', 'http://ilinkai.weixin.qq.com', 'https://u@ilinkai.weixin.qq.com'):
        with pytest.raises(ValueError):
            api_url(value)
    api = ILinkClient('private')
    def timeout(request):
        raise httpx.ReadTimeout('private', request=request)
    api.http = httpx.AsyncClient(transport=httpx.MockTransport(timeout))
    assert await api.request('getupdates', payload={'get_updates_buf': 'cursor'}) == {'msgs': [], 'get_updates_buf': 'cursor'}
    await api.close()


async def test_weixin_http_logs_redact_qr_and_media_query_tokens(caplog):
    import logging
    from services.channels.weixin_api import ILinkClient
    api = ILinkClient()
    api.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={'status': 'wait'})))
    with caplog.at_level(logging.INFO, logger='httpx'):
        await api.request('get_qrcode_status', params={'qrcode': 'private-qr-token'})
        await api.http.get('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=private-media-token')
    assert 'private-qr-token' not in caplog.text
    assert 'private-media-token' not in caplog.text
    await api.close()
    api.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500, text='private')))
    with pytest.raises(RuntimeError) as exc:
        await api.request('sendmessage', payload={})
    assert 'private' not in str(exc.value)
    await api.close()


async def test_weixin_download_decrypts_hex_base64_and_enforces_size(tmp_path):
    import base64
    from services.channels.weixin_media import encrypt
    channel = adapter(tmp_path)
    key = bytes(range(16))
    raw = b'picture'
    channel._api.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=encrypt(raw, key))))
    attachment = ChannelAttachment('image', 'image.jpg', reference={
        'encrypt_query_param': 'query', 'aes_key': base64.b64encode(key.hex().encode()).decode()})
    try:
        assert await channel.download(attachment) == (raw, 'image.jpg')
        from services.channels.weixin_media import download
        with pytest.raises(ValueError, match='超过'):
            await download(channel._api, attachment, 3)
    finally:
        await channel.stop()


async def test_weixin_relogin_preserves_identity_and_delete_cleans_state(bots):
    manager, project, *_ = bots
    manager._factories['weixin'] = lambda *args: None  # Disabled bots do not instantiate adapters.
    async def authorize(account, owner, bot_id=''):
        manager.weixin_login.api.request = AsyncMock(side_effect=[
            {'qrcode': 'qr', 'qrcode_img_content': 'scan'},
            {'status': 'confirmed', 'ilink_bot_id': account, 'ilink_user_id': owner, 'bot_token': 'private-' + account}])
        row = await manager.weixin_login.start(bot_id)
        await manager.weixin_login.poll(row['login_id'])
        return row['login_id']
    receipt = await authorize('account', 'owner')
    bot = await manager.create_bot({'platform': 'weixin', 'name': '微信', 'login_id': receipt,
        'default_project_id': project.id, 'default_target_type': 'project'})
    bad = await authorize('other', 'stranger', bot['id'])
    with pytest.raises(ValueError, match='原绑定'):
        await manager.update_bot(bot['id'], {'login_id': bad})
    good = await authorize('account', 'owner', bot['id'])
    updated = await manager.update_bot(bot['id'], {'login_id': good, 'secret': 'injected'})
    assert updated['app_id'] == 'account'
    assert manager._store.values['channel_bots']['bots'][0]['secret'] == 'private-account'
    from services.channels.weixin_state import WeixinState
    state = WeixinState({'id': bot['id'], 'app_id': 'account'})
    await state.save()
    with pytest.raises(ValueError, match='私聊'):
        await manager.bind_group(project.id, 'task-1', bot['id'], 'group')
    await manager.delete_bot(bot['id'])
    assert not state.path.exists()


async def test_weixin_block_stream_sends_before_finish_and_does_not_repeat(tmp_path):
    import main
    from services.channels.reply_stream import ChannelReplyStream
    channel = adapter(tmp_path)
    recipient = IncomingMessage('b', 'stream', 'single', 'owner', 'owner', '')
    entered, acknowledge = asyncio.Event(), asyncio.Event()
    calls = []
    async def request(endpoint, **kwargs):
        calls.append(kwargs['payload']['msg'])
        entered.set()
        await acknowledge.wait()
        return {}
    channel._api.request = request
    stream = ChannelReplyStream(lambda text: channel.update_reply(recipient, text))
    first = '第一段。' * 50
    try:
        stream.update(first)
        await asyncio.wait_for(entered.wait(), 1)
        stream.update(first + '第二段。')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        closing = asyncio.create_task(stream.close())
        await asyncio.sleep(.01)
        assert not closing.done(), 'finish must wait for an in-flight block acknowledgement'
        acknowledge.set()
        await asyncio.wait_for(closing, 1)
        await channel.send_text(recipient, first + '第二段。')
        assert [body['item_list'][0]['text_item']['text'] for body in calls] == [first, '第二段。']
        assert len({body['client_id'] for body in calls}) == 2
        assert all(body['message_state'] == 2 for body in calls)
    finally:
        acknowledge.set()
        await stream.close()
        await channel.stop()


async def test_weixin_stream_defers_media_links_and_only_sends_remaining_text(tmp_path, monkeypatch):
    from services.channels import weixin_media
    upload = AsyncMock(return_value={'type': 2, 'image_item': {'media': {'encrypt_query_param': 'image'}}})
    monkeypatch.setattr(weixin_media, 'upload', upload)
    channel = adapter(tmp_path)
    channel._api.request = AsyncMock(return_value={})
    recipient = IncomingMessage('b', 'media-stream', 'single', 'owner', 'owner', '')
    prefix = '说明。' * 70
    await channel.update_reply(recipient, prefix + '![图片](.workstep/uploads/p.png)')
    assert channel._api.request.await_count == 1
    assert channel._api.request.await_args.kwargs['payload']['msg']['item_list'][0]['text_item']['text'] == prefix
    await channel.update_reply(recipient, prefix + '![图片](.workstep/uploads/p.png)后文')
    assert channel._api.request.await_count == 1
    await channel.send(recipient, OutgoingMessage(prefix + '图片后文', (ChannelAttachment('image', 'p.png', data=b'image'),)))
    assert channel._api.request.await_args_list[-2].kwargs['payload']['msg']['item_list'][0]['text_item']['text'] == '图片后文'
    assert channel._api.request.await_args.kwargs['payload']['msg']['item_list'][0]['type'] == 2
    assert upload.await_count == 1
    # Identical cumulative snapshots and the final text must not repeat a block.
    await channel.update_reply(recipient, prefix)
    count = channel._api.request.await_count
    await channel.update_reply(recipient, prefix)
    await channel.send_text(recipient, prefix)
    assert channel._api.request.await_count == count
    await channel.stop()


async def test_weixin_short_blocks_wait_until_finish_and_failed_blocks_retry(tmp_path):
    channel = adapter(tmp_path)
    recipient = IncomingMessage('b', 'short', 'single', 'owner', 'owner', '')
    channel._api.request = AsyncMock(return_value={})
    pending = asyncio.create_task(channel.update_reply(recipient, '短回答'))
    await asyncio.sleep(.01)
    assert channel._api.request.await_count == 0
    await asyncio.wait_for(pending, 4)
    assert channel._api.request.await_count == 0
    await channel.send_text(recipient, '短回答')
    assert channel._api.request.await_count == 1
    channel._api.request = AsyncMock(side_effect=[RuntimeError('网络失败'), {}])
    text = '重试' * 100 + '。'
    with pytest.raises(RuntimeError):
        await channel.update_reply(recipient, text)
    await channel.send_text(recipient, text)
    assert channel._api.request.await_count == 2
    assert channel._api.request.await_args.kwargs['payload']['msg']['item_list'][0]['text_item']['text'] == text
    await channel.stop()


async def test_weixin_manager_routes_live_blocks_and_final_tail(bots):
    from types import SimpleNamespace
    from services.channels.responder import ChatSessionResponder
    from services.channels.weixin import WeixinAdapter
    manager, project, *_ = bots
    manager.weixin_login.api.request = AsyncMock(side_effect=[
        {'qrcode': 'qr', 'qrcode_img_content': 'scan'},
        {'status': 'confirmed', 'bot_token': 'token', 'ilink_bot_id': 'account', 'ilink_user_id': 'owner'},
    ])
    receipt = await manager.weixin_login.start()
    await manager.weixin_login.poll(receipt['login_id'])
    def factory(bot, on_message, on_state):
        channel = WeixinAdapter(bot, on_message, on_state)
        channel.start = AsyncMock()
        return channel
    manager._factories['weixin'] = factory
    bot = await manager.create_bot({'platform': 'weixin', 'name': '流式', 'enabled': True,
        'login_id': receipt['login_id'], 'default_project_id': project.id, 'default_target_type': 'project'})
    channel = manager._adapters[bot['id']]
    sent, finish = asyncio.Event(), asyncio.Event()
    texts = []
    async def request(endpoint, **kwargs):
        if endpoint == 'sendmessage':
            texts.append(kwargs['payload']['msg']['item_list'][0]['text_item']['text'])
            sent.set()
        return {}
    channel._api.request = request
    first = '实时回复。' * 40
    async def produce():
        scope = {'project_id': project.id, 'session_id': 'session', 'channel': 'session_chat', 'messageId': 'answer'}
        await manager._event_bus.publish({**scope, 'type': 'TEXT_MESSAGE_CHUNK', 'delta': first})
        await finish.wait()
        await manager._event_bus.publish({**scope, 'type': 'TEXT_MESSAGE_END', 'content': first + '结束。'})
    producers = []
    class Module:
        def create_session(self, *args, **kwargs):
            return {'id': 'session'}
        def submit_message(self, *args, **kwargs):
            return SimpleNamespace(turn_id='turn', assistant_message_id='answer')
        def start_queued_turn(self, turn):
            producers.append(asyncio.create_task(produce()))
    manager._responder = ChatSessionResponder(manager._event_bus, manager._project_manager, Module())
    pending = asyncio.create_task(manager.handle_message(IncomingMessage(bot['id'], 'incoming', 'single', 'owner', 'owner', '问题')))
    try:
        await asyncio.wait_for(sent.wait(), 1)
        assert not pending.done()
    finally:
        finish.set()
        await asyncio.wait_for(pending, 2)
        await asyncio.gather(*producers)
    assert texts == [first, '结束。']
    assert not channel._sent_text


async def test_weixin_stream_coalesces_two_character_prefix_and_holds_incomplete_sentence(tmp_path):
    channel = adapter(tmp_path)
    channel._api.request = AsyncMock(return_value={})
    recipient = IncomingMessage('b', 'coalesce', 'single', 'owner', 'owner', '')
    await channel.update_reply(recipient, '如果')
    assert channel._api.request.await_count == 0
    sentence = '如果' + '说明内容' * 55 + '。'
    await channel.update_reply(recipient, sentence + '接下来')
    assert channel._api.request.await_count == 1
    assert channel._api.request.await_args.kwargs['payload']['msg']['item_list'][0]['text_item']['text'] == sentence
    await channel.update_reply(recipient, sentence + '接下来还有一点')
    assert channel._api.request.await_count == 1
    await channel.send_text(recipient, sentence + '接下来还有一点。')
    assert channel._api.request.await_args.kwargs['payload']['msg']['item_list'][0]['text_item']['text'] == '接下来还有一点。'
    await channel.stop()


async def test_weixin_audio_file_send_api_preserves_playable_wav_and_stays_responsive(bots):
    import io
    import wave
    import main
    from services.channels.weixin import WeixinAdapter
    from services.channels.weixin_media import decrypt
    manager, project, *_ = bots
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b'\0\0' * 1600)
    original = audio.getvalue()
    path = project.path / 'reply.wav'
    await asyncio.to_thread(path.write_bytes, original)
    manager.weixin_login.api.request = AsyncMock(side_effect=[
        {'qrcode': 'qr', 'qrcode_img_content': 'scan'},
        {'status': 'confirmed', 'bot_token': 'token', 'ilink_bot_id': 'account', 'ilink_user_id': 'owner'},
    ])
    receipt = await manager.weixin_login.start()
    await manager.weixin_login.poll(receipt['login_id'])
    def factory(bot, on_message, on_state):
        channel = WeixinAdapter(bot, on_message, on_state)
        channel.start = AsyncMock()
        return channel
    manager._factories['weixin'] = factory
    bot = await manager.create_bot({'platform': 'weixin', 'name': '音频', 'enabled': True,
        'login_id': receipt['login_id'], 'default_project_id': project.id, 'default_target_type': 'project'})
    channel = manager._adapters[bot['id']]
    requests = []
    async def api(endpoint, **kwargs):
        requests.append((endpoint, kwargs['payload']))
        return {'upload_param': 'audio-upload'} if endpoint == 'getuploadurl' else {}
    channel._api.request = api
    entered, release = asyncio.Event(), asyncio.Event()
    async def upload(request):
        metadata = requests[-1][1]
        assert metadata['media_type'] == 3  # FILE, never silently dropped VOICE.
        assert decrypt(request.content, bytes.fromhex(metadata['aeskey'])) == original
        entered.set()
        await release.wait()
        return httpx.Response(200, headers={'x-encrypted-param': 'audio-download'})
    channel._api.http = httpx.AsyncClient(transport=httpx.MockTransport(upload))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/channel-bots/send', json={
            'project_id': project.id, 'bot_id': bot['id'], 'user_id': 'owner',
            'attachments': [{'kind': 'file', 'path': 'reply.wav'}],
        }))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        finally:
            release.set()
        response = await asyncio.wait_for(pending, 1)
        assert response.status_code == 200, response.text
        assert response.json()['sent'] is True
    message = requests[-1][1]['msg']
    assert message['to_user_id'] == 'owner'
    item = message['item_list'][0]
    assert item['type'] == 4
    assert item['file_item']['file_name'] == 'reply.wav'
    assert item['file_item']['len'] == str(len(original))
    assert all('voice_item' not in item for item in message['item_list'])
