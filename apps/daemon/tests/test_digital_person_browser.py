import asyncio
import json
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services import digital_person_browser as browser
from services.connectors.store import ConnectorStore
from tests.test_chat_session import MemoryConfigStore


@pytest.fixture
def local(tmp_path, monkeypatch):
    monkeypatch.setattr(browser, 'directory', lambda: tmp_path / 'browser')
    monkeypatch.setattr(browser, 'connector_store', ConnectorStore(tmp_path / 'connectors'))
    monkeypatch.setattr(browser, 'config_store', MemoryConfigStore())
    monkeypatch.setattr(browser, 'package_candidates', lambda: [tmp_path / 'browser/node_modules/@playwright/mcp/cli.js'])
    monkeypatch.setattr(browser.shutil, 'which', lambda command: '/usr/bin/' + command)
    monkeypatch.setattr(browser, 'engine_compatible', lambda: True)
    monkeypatch.setattr(browser, 'browser_candidates', lambda: [])
    monkeypatch.setattr(browser, 'probe_package', lambda *args: {})
    monkeypatch.setattr(browser, '_install_task', None)
    monkeypatch.setattr(browser, '_install_error', '')
    return tmp_path


def installed(local, monkeypatch):
    cli=local / 'browser/node_modules/@playwright/mcp/cli.js'
    cli.parent.mkdir(parents=True); cli.write_text('')
    executable=local / 'chrome'; executable.touch()
    monkeypatch.setattr(browser, 'probe_package', lambda *args: {'version':'0.0.85','browser':str(executable),'core_cli':str(cli)})
    return cli,executable


def test_scan_missing_does_not_download_or_claim_ready(local):
    result=browser.scan()
    assert result['status']=='missing'
    assert not result['ready']
    assert not browser.directory().exists()


def test_scan_reuses_local_browser_and_mcp_without_install(local, monkeypatch):
    installed(local,monkeypatch)
    result=browser.scan()
    assert result['ready']
    assert result['version']=='0.0.85'
    assert not result['enabled']


async def test_ready_install_does_not_download_again(local,monkeypatch):
    installed(local,monkeypatch)
    async def unexpected(*args,**kwargs): pytest.fail('must reuse existing installation')
    monkeypatch.setattr(browser,'run_command',unexpected)
    await browser.install()
    assert browser.scan()['ready']


def test_enable_reuses_connector_and_keeps_other_session_choices(local,monkeypatch):
    installed(local,monkeypatch)
    other=browser.connector_store.save({'name':'other','kind':'cli','command':'gh'})
    browser.connector_store.select('p','s',[other['id']])
    browser.set_enabled(True)
    browser.attach('p','s')
    browser.attach('p','s')
    ids=[item['id'] for item in browser.connector_store.selected('p','s')]
    assert len(ids)==2 and other['id'] in ids
    browser.set_enabled(False)
    assert len(browser.connector_store.selected('p','s'))==1
    assert browser.connector_store.resolve(other['id'])


async def test_download_failure_is_visible_and_retryable(local,monkeypatch):
    async def failed(*args,**kwargs): raise ValueError('下载失败')
    monkeypatch.setattr(browser,'install',failed)
    await browser.start_install()
    await browser._install_task
    assert '下载失败' in browser.scan()['error']
    assert not browser.scan()['installing']
    async def success(): installed(local,monkeypatch)
    monkeypatch.setattr(browser,'install',success)
    await browser.start_install(); await browser._install_task
    assert browser.scan()['ready'] and not browser.scan()['error']


async def test_host_api_slow_scan_keeps_loop_responsive(local,monkeypatch):
    from api.digital_person import router
    entered,release=threading.Event(),threading.Event()
    def slow():
        entered.set();release.wait(3)
        return {'status':'missing'}
    monkeypatch.setattr(browser,'scan',slow)
    app=FastAPI(); app.include_router(router)
    @app.get('/health')
    async def health(): return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/browser'))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally: release.set()
        assert (await pending).status_code==200


async def test_project_identity_cannot_scan_install_or_enable_host_browser(local):
    from api.digital_person import router
    from services.remote_access import ActorSnapshot,actor_context
    app=FastAPI();app.include_router(router)
    with actor_context(ActorSnapshot(source='browser',actor_id='u',user_name='test',device_id='d',device_name='device',project_id='p',access_level='edit')):
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
            for method,path,kwargs in [('GET','',{}),('POST','/install',{}),('PUT','',{'json':{'enabled':True}})]:
                assert (await client.request(method,'/api/digital-person/browser'+path,**kwargs)).status_code==403


async def test_missing_plugin_reuses_installed_browser(local,monkeypatch):
    executable=local/'existing-chrome';executable.touch()
    monkeypatch.setattr(browser,'browser_candidates',lambda:[executable])
    calls=[]
    async def download(command,env):
        calls.append(command)
        installed(local,monkeypatch)
    monkeypatch.setattr(browser,'run_command',download)
    await browser.install()
    assert len(calls)==1
    assert calls[0][1]=='install'
    assert '@playwright/mcp@0.0.85' in calls[0]


async def test_missing_browser_only_downloads_browser(local,monkeypatch):
    cli,executable=installed(local,monkeypatch);executable.unlink()
    calls=[]
    async def download(command,env):
        calls.append(command);executable.touch()
    monkeypatch.setattr(browser,'run_command',download)
    await browser.install()
    assert len(calls)==1
    assert calls[0][-2:]==['install','chromium']


async def test_install_is_single_flight_and_health_stays_responsive(local,monkeypatch):
    from api.digital_person import router
    entered,release=asyncio.Event(),asyncio.Event();calls=0
    async def download():
        nonlocal calls
        calls+=1;entered.set();await release.wait()
    monkeypatch.setattr(browser,'install',download)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health(): return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        try:
            first=await client.post('/api/digital-person/browser/install')
            await asyncio.wait_for(entered.wait(),1)
            second=await client.post('/api/digital-person/browser/install')
            assert first.status_code==second.status_code==200
            assert calls==1
            assert first.json()['installing']
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:
            release.set()
            await browser._install_task


def test_unsupported_engine_is_visible_and_cannot_enable(local,monkeypatch):
    installed(local,monkeypatch)
    monkeypatch.setattr(browser,'engine_compatible',lambda:False)
    assert browser.scan()['engine_compatible'] is False
    with pytest.raises(ValueError,match='does not support MCP'):
        browser.set_enabled(True)
