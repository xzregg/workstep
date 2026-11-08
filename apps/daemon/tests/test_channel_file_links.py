from types import SimpleNamespace

import pytest

from services.channels.file_links import ChannelFileLinks


def converter(base='https://example.test', root='/projects/demo'):
    return ChannelFileLinks(SimpleNamespace(id='p1', path=root), base_url=base)


def test_local_links_relative_absolute_line_and_escaped_names():
    links = converter()
    result = links.render('[代码](/projects/demo/src/main.py:12) [报告](<docs/a b(1).md>)')
    assert '/projects/demo' not in result
    assert 'https://example.test/file-preview?' in result
    assert 'path=src%2Fmain.py' in result and 'line=12' in result
    assert 'path=docs%2Fa+b%281%29.md' in result
    assert links.render('[代码](src/main.py#L12)') == links.render('[代码](/projects/demo/src/main.py:12)')


def test_every_stream_prefix_hides_unfinished_link_and_final_degrades():
    source = '前文 [报告](/projects/demo/report.md) 后文'
    links = converter()
    for end in range(len(source) + 1):
        rendered = links.render(source[:end], streaming=True)
        assert '/projects/demo' not in rendered
        if end >= len('前文 '):
            assert rendered.startswith('前文 ')
    assert 'file-preview' in links.render(source[:-3], streaming=True)
    assert links.render('前文 [报告](/projects/demo/rep') == '前文 报告'
    assert links.render('前文 [/projects/demo/rep', streaming=True) == '前文 '


def test_external_code_and_attachments_remain_untouched():
    links = converter()
    source = '[官网](https://example.org/a) `[/tmp/x](/tmp/x)`\n```md\n[x](/tmp/x)\n```\n'
    assert links.render(source) == source
    assert links.render('[附件](.workstep/uploads/file.txt)', streaming=True).startswith('[附件](https://')


def test_outside_missing_address_and_path_labels_do_not_leak():
    links = converter()
    assert links.render('[/private/secret.txt](/private/secret.txt)') == 'secret.txt'
    assert links.render('[文件](../../private.txt)') == '文件'
    assert converter('').render('[/projects/demo/a.txt](/projects/demo/a.txt)') == 'a.txt'
    assert links.render('[文件](file:///projects/demo/a.txt)').startswith('[文件](https://')
    assert links.render('[文件](/projects/demo-other/a.txt)') == '文件'


def test_windows_paths_and_gateway_prefix():
    links = converter('https://gateway.test/workspace/device', 'C:\\Projects\\Demo')
    result = links.render('[文件](C:\\Projects\\Demo\\a.txt)')
    assert 'https://gateway.test/workspace/device/file-preview?' in result
    assert 'path=a.txt' in result
    assert links.render('[文件](D:\\private.txt)') == '文件'


def test_encoded_filename_and_markdown_escapes_are_preserved():
    links = converter()
    result = links.render(r'[文件](docs/a%23b%3F.txt) [文件](docs/a\(b\).md)')
    assert 'path=docs%2Fa%23b%3F.txt' in result
    assert 'path=docs%2Fa%28b%29.md' in result


@pytest.mark.asyncio
async def test_address_loaded_once_without_network(monkeypatch):
    import services.channels.file_links as module
    calls = []
    def addresses():
        calls.append(True)
        return [{'kind': 'gateway', 'task_base_url': 'https://gateway.test/workspace/device'},
                {'kind': 'external', 'task_base_url': 'https://direct.test'}]
    monkeypatch.setattr(module, 'base_addresses', addresses)
    links = ChannelFileLinks(SimpleNamespace(id='p1', path='/projects/demo'))
    assert await links.convert('纯文字', streaming=True) == '纯文字'
    assert not calls
    first = await links.convert('[代码](a.py)', streaming=True)
    assert 'gateway.test/workspace/device/file-preview' in first
    assert await links.convert('[代码](a.py)') == first
    assert len(calls) == 1


def test_reference_links_and_partial_definitions():
    links = converter()
    source = '查看 [报告][report]\n\n[report]: /projects/demo/report.md\n'
    rendered = links.render(source)
    assert '[报告][report]' in rendered
    assert '[report]: https://example.test/file-preview?' in rendered
    assert '/projects/demo' not in rendered
    for end in range(source.index('[report]:') + 1, len(source)):
        assert '/projects/demo' not in links.render(source[:end], streaming=True)
    assert links.render('正文 [尚未闭合') == '正文 [尚未闭合'


@pytest.mark.asyncio
async def test_progress_sends_before_completion_and_suppresses_unchanged_tail():
    from unittest.mock import AsyncMock
    links = converter()
    send = AsyncMock()
    await links.send_progress(send, '前文 [报告](/projects/demo/')
    send.assert_awaited_once_with('前文 ')
    await links.send_progress(send, '前文 [报告](/projects/demo/report')
    assert send.await_count == 1
    await links.send_progress(send, '前文 [报告](/projects/demo/report.md)')
    assert send.await_count == 2
    assert 'file-preview?' in send.await_args.args[0]


@pytest.mark.asyncio
async def test_address_failure_degrades_without_losing_reply(monkeypatch):
    import services.channels.file_links as module
    def broken():
        raise OSError('unavailable')
    monkeypatch.setattr(module, 'base_addresses', broken)
    links = ChannelFileLinks(SimpleNamespace(id='p1', path='/projects/demo'))
    assert await links.convert('已完成 [报告](/projects/demo/report.md)') == '已完成 报告'


@pytest.mark.asyncio
async def test_slow_config_does_not_block_loop(monkeypatch):
    import asyncio
    import threading
    import services.channels.file_links as module
    entered, release = threading.Event(), threading.Event()
    def slow():
        entered.set()
        assert release.wait(2)
        return []
    monkeypatch.setattr(module, 'base_addresses', slow)
    links = ChannelFileLinks(SimpleNamespace(id='p1', path='/projects/demo'))
    pending = asyncio.create_task(links.convert('[文件](a.txt)'))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        await asyncio.wait_for(asyncio.sleep(0), .1)
        assert not pending.done()
    finally:
        release.set()
        assert await pending == '文件'


@pytest.mark.asyncio
async def test_final_send_reuses_address_when_stream_is_cancelled_during_setup(monkeypatch):
    import asyncio
    import threading
    import services.channels.file_links as module
    entered, release = threading.Event(), threading.Event()
    def slow():
        entered.set()
        assert release.wait(2)
        return [{'kind': 'external', 'task_base_url': 'https://direct.test'}]
    monkeypatch.setattr(module, 'base_addresses', slow)
    links = ChannelFileLinks(SimpleNamespace(id='p1', path='/projects/demo'))
    pending = asyncio.create_task(links.convert('[文件](a.txt)', streaming=True))
    final = None
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        final = asyncio.create_task(links.convert('[文件](a.txt)'))
        await asyncio.sleep(.02)
        assert not final.done()
    finally:
        release.set()
        if final:
            assert 'direct.test/file-preview?' in await final
