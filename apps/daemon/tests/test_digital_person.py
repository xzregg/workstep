import asyncio
import threading
from types import SimpleNamespace

import pytest
from tests.test_chat_session import chat_module
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def setup(tmp_path, monkeypatch):
    from api import digital_person
    from services import config, digital_person as service
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config.config_store, "_cache", None)
    monkeypatch.setattr(service, "config_store", config.config_store)
    app = FastAPI()
    app.include_router(digital_person.router)
    @app.get("/health")
    async def health():
        return {"ok": True}
    return app, service


async def test_profile_roundtrip_validation_and_restart(setup):
    app, service = setup
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        original = (await client.get("/api/digital-person")).json()
        assert original["enabled"] is False
        payload = {**original, "enabled": True, "name": "小研", "duties": "跟进研发", "personality": "直接"}
        response = await client.put("/api/digital-person", json=payload)
        assert response.status_code == 200
        service.config_store._cache = None
        assert (await client.get("/api/digital-person")).json()["duties"] == "跟进研发"
        assert (await client.put("/api/digital-person", json={**payload, "name": "   "})).status_code == 422
        assert (await client.put("/api/digital-person", json={**payload, "workspace": "/tmp"})).status_code == 422


async def test_personal_check_interval_and_conversation_rules(setup, monkeypatch):
    from services import customization_workspace
    app, service = setup
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda p: p.id == 'home')
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        payload = (await client.get('/api/digital-person')).json()
        payload.update(enabled=True, proactive_interval_minutes=15, conversation_rules='先给结论，再解释依据')
        assert (await client.put('/api/digital-person', json=payload)).status_code == 200
        service.config_store._cache = None
        assert (await client.get('/api/digital-person')).json()['proactive_interval_minutes'] == 15
        assert '先给结论，再解释依据' in service.prompt_for_project(SimpleNamespace(id='home'))
        assert service.prompt_for_project(SimpleNamespace(id='other')) == ''
        for interval in (0, 1441, 1.5):
            assert (await client.put('/api/digital-person', json={**payload, 'proactive_interval_minutes': interval})).status_code == 422


@pytest.mark.parametrize('endpoint', ['/api/digital-person', '/api/digital-person/voice-wake'])
async def test_slow_save_does_not_block_health(setup, monkeypatch, endpoint):
    app, service = setup
    entered, release = threading.Event(), threading.Event()
    original = service.config_store.set
    def slow(*args):
        entered.set()
        assert release.wait(3)
        return original(*args)
    monkeypatch.setattr(service.config_store, "set", slow)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        payload = (await client.get(endpoint)).json()
        payload.pop('available', None); payload.pop('listening', None)
        pending = asyncio.create_task(client.put(endpoint, json=payload))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get("/health"), .5)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 200


@pytest.mark.parametrize("source", ["share", "remote_project"])
async def test_project_identity_cannot_manage_host(setup, source):
    from services.remote_access import ActorSnapshot, actor_context
    app, _ = setup
    actor = ActorSnapshot(actor_id="u", user_name="u", device_id="d", device_name="d", source=source, project_id="p", access_level="edit")
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.get("/api/digital-person")).status_code == 403
            assert (await client.put("/api/digital-person", json={})).status_code == 403
            assert (await client.get("/api/digital-person/voice-wake")).status_code == 403
            assert (await client.put("/api/digital-person/voice-wake", json={})).status_code == 403


def test_person_prompt_only_in_fixed_workspace_and_when_enabled(setup, monkeypatch):
    from services import customization_workspace
    from services.digital_person import DigitalPersonProfile
    _, service = setup
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda p: p.id == "home")
    home, other = SimpleNamespace(id="home"), SimpleNamespace(id="other")
    profile = DigitalPersonProfile(enabled=True, name="小研", duties="复查证据", personality="直接")
    service.save_profile(profile)
    assert "复查证据" in service.prompt_for_project(home)
    assert service.prompt_for_project(other) == ""
    service.save_profile(profile.model_copy(update={"enabled": False}))
    assert service.prompt_for_project(home) == ""


async def test_identity_reaches_engine_changes_on_resume_and_does_not_pollute_settings(chat_module, monkeypatch):
    from tests.test_chat_role_binding import install_engine, send
    from services.digital_person import DigitalPersonProfile, save_profile
    from services import customization_workspace
    module, _, _, project, store = chat_module
    monkeypatch.setattr('services.digital_person.config_store', store)
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda p: p.id == project.id)
    save_profile(DigitalPersonProfile(enabled=True, name="小研", duties="IDENTITY ORIGINAL"))
    sid = module.create_session(project.id)['id']
    calls, _ = install_engine(module, monkeypatch)
    assert await send(module, project, sid, 'first') == 'completed'
    assert 'IDENTITY ORIGINAL' in calls[-1]
    assert module.get_system_prompt(project.id) == ''
    save_profile(DigitalPersonProfile(enabled=True, duties="IDENTITY UPDATED", conversation_rules="RULE UPDATED"))
    assert await send(module, project, sid, 'changed') == 'completed'
    assert 'IDENTITY UPDATED' in calls[-1] and 'IDENTITY ORIGINAL' not in calls[-1]
    assert 'RULE UPDATED' in calls[-1]
    save_profile(DigitalPersonProfile(enabled=False))
    assert await send(module, project, sid, 'off') == 'completed'
    assert '模式已关闭' in calls[-1] and 'IDENTITY UPDATED' not in calls[-1]


async def test_host_config_is_independent_of_retired_install_capability(setup, monkeypatch):
    import main
    from services.gateway_client.policy import ManagedPolicyCache
    from services.remote_access import ActorSnapshot, actor_context
    app, _ = setup
    monkeypatch.setattr(main, 'gateway_client', SimpleNamespace(managed_config=object(), policy_cache=ManagedPolicyCache()))
    with actor_context(ActorSnapshot('u', 'user', 'd', 'device', 'managed')):
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            response = await client.get('/api/digital-person')
            assert response.status_code == 200
            assert (await client.put('/api/digital-person', json=response.json())).status_code == 200


async def test_voice_wake_draft_persists_without_claiming_listener(setup):
    app, service = setup
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        response = await client.get('/api/digital-person/voice-wake')
        assert response.status_code == 200
        assert response.json()['listening'] is False
        response = await client.put('/api/digital-person/voice-wake', json={'keyword':'你好小舟','sensitivity':'high'})
        assert response.status_code == 200
        service.config_store._cache = None
        result = (await client.get('/api/digital-person/voice-wake')).json()
        assert result['keyword'] == '你好小舟'
        assert result['available'] is False and result['listening'] is False
        for payload in ({'keyword':' '}, {'sensitivity':'invalid'}, {'enabled':True}):
            assert (await client.put('/api/digital-person/voice-wake', json=payload)).status_code == 422


@pytest.mark.parametrize('endpoint,changes', [
    ('/api/digital-person', {'name': '新名字'}),
    ('/api/digital-person', {'enabled': False}),
    ('/api/digital-person', {'duties': '未保存的新职责'}),
    ('/api/digital-person/voice-wake', {'keyword': '你好小舟', 'sensitivity': 'high'}),
])
@pytest.mark.parametrize('existing', [False, True])
async def test_failed_disk_write_preserves_active_config_and_allows_retry(setup, monkeypatch, endpoint, changes, existing):
    from services import config, customization_workspace
    app, service = setup
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda p: True)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        before = (await client.get(endpoint)).json()
        if existing:
            seed = {k: v for k, v in before.items() if k not in {'available', 'listening'}}
            if endpoint == '/api/digital-person':
                seed['enabled'] = True
            assert (await client.put(endpoint, json=seed)).status_code == 200
            before = (await client.get(endpoint)).json()
        payload = {k: v for k, v in before.items() if k not in {'available', 'listening'}}
        payload.update(changes)
        if not existing and changes == {'enabled': False}:
            payload['enabled'] = True
        prompt_before = service.prompt_for_project(SimpleNamespace(id='home'))
        def fail_replace(*args):
            raise OSError('synthetic disk replacement failure')
        with monkeypatch.context() as failure:
            failure.setattr(config.os, 'replace', fail_replace)
            assert (await client.put(endpoint, json=payload)).status_code == 503
            assert (await client.get(endpoint)).json() == before
            assert service.prompt_for_project(SimpleNamespace(id='home')) == prompt_before
        service.config_store._cache = None
        assert (await client.get(endpoint)).json() == before
        assert not list(config.CONFIG_DIR.glob('*.tmp'))
        assert (await client.put(endpoint, json=payload)).status_code == 200
        service.config_store._cache = None
        after = (await client.get(endpoint)).json()
        assert all(after[k] == v for k, v in payload.items())


@pytest.mark.parametrize("channel", [False, True])
def test_digital_person_engine_defaults_are_independent(chat_module, monkeypatch, channel):
    from services import digital_person, customization_workspace
    from agent_assistants.channel_chat import ChannelChatModule
    module, bus, projects, project, store = chat_module
    if channel:
        module = ChannelChatModule(bus, projects)
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda p: p.id == project.id)
    store.set("digital_person", {"enabled": True})
    store.set("assistant_defaults", {
        "digital_person": {"engine": "fake-chat", "model": "digital-model", "fast_model": "digital-fast", "vision_model": "digital-vision"},
        module._config.name: {"engine": "fake-chat", "model": "ordinary-model"},
    })
    session = module.create_session(project.id)
    assert session["model"] == "digital-model"
    assert session["fast_model"] == "digital-fast"
    assert session["vision_model"] == "digital-vision"
    store.set("digital_person", {"enabled": False})
    assert module.create_session(project.id)["model"] == "ordinary-model"


@pytest.mark.parametrize("channel", [False, True])
async def test_digital_engine_parameters_reach_runtime(chat_module, monkeypatch, channel):
    from services import customization_workspace
    from agent_assistants.channel_chat import ChannelChatModule
    from tests.test_chat_role_binding import send
    module, bus, projects, project, store = chat_module
    if channel:
        module = ChannelChatModule(bus, projects)
    monkeypatch.setattr('services.digital_person.config_store', store)
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda p: p.id == project.id)
    store.set('digital_person', {'enabled': True})
    store.set('assistant_defaults', {
        'digital_person': {'engine': 'claude', 'model': 'digital', 'thinking_effort': 'high'},
        module._config.name: {'engine': 'codex', 'model': 'ordinary', 'thinking_effort': 'low'},
    })
    calls = []
    async def invoke(engine, model, *args, **kwargs):
        calls.append((engine, model, kwargs.get('thinking_effort'), kwargs.get('workstep_tools')))
        return 'done', [], 'thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    row = await projects.run_db(project.id, lambda _: module.create_session(project.id))
    assert await send(module, project, row['id'], 'engine-check') == 'completed'
    assert calls == [('claude', 'digital', 'high', True)]

async def test_live_role_reference_updates_without_copying_profile(chat_module,monkeypatch):
    from services import digital_person,customization_workspace
    _,_,_,project,store=chat_module
    monkeypatch.setattr(digital_person,'config_store',store)
    monkeypatch.setattr(customization_workspace,'is_default_workspace',lambda p:True)
    role={'name':'研发','prompt':'先确认需求'}
    monkeypatch.setattr('agent_assistants.chat_roles.resolve_binding',lambda _: (role['name'],role['prompt']))
    digital_person.save_profile(digital_person.DigitalPersonProfile(enabled=True,role_binding={'kind':'role','id':'rd'}))
    assert '先确认需求' in digital_person.prompt_for_project(project)
    role['prompt']='先核对验收标准'
    assert '先核对验收标准' in digital_person.prompt_for_project(project)


@pytest.mark.parametrize("enabled,home", [(True,True),(False,True),(True,False)])
def test_channel_digital_identity_replaces_legacy_assistant_prompt(chat_module, monkeypatch, enabled, home):
    from agent_assistants.channel_chat import ChannelChatModule
    from services import customization_workspace, digital_person
    ordinary, bus, projects, project, store = chat_module
    monkeypatch.setattr(digital_person, "config_store", store)
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda p: home)
    store.set("digital_person", {"enabled":enabled,"name":"小研"})
    module=ChannelChatModule(bus, projects, register=False)
    monkeypatch.setattr(module, "get_system_prompt", lambda _: "项目自定义规则")
    monkeypatch.setattr(ordinary, "get_system_prompt", lambda _: "项目自定义规则")
    monkeypatch.setattr(module, "_role_system_prompt", lambda _: "会话角色规则")
    monkeypatch.setattr(ordinary, "_role_system_prompt", lambda _: "会话角色规则")
    monkeypatch.setattr("agent_assistants.channel_chat.build_channel_background", lambda _: "Current sender: Alice")
    session=SimpleNamespace(project_id=project.id, session_id="source-session", engine="fake-chat",
        resolved_session_id="native", extra={}, messages=[{"role":"user","content":"你好"}])
    rules=module._engine_system_prompt(session)
    if enabled and home:
        assert "姓名：小研" in rules
        assert "WorkStep channel chat assistant" not in rules
        assert "Avoid complex formatting" not in rules
        assert "渠道交互" not in rules
        assert "workstep_bind_channel_group" not in rules
        assert rules == ordinary._engine_system_prompt(session)
        assert module._session_system_prompt_each_turn(session) is True
    assert "WorkStep channel chat assistant" not in rules
    assert rules == ordinary._engine_system_prompt(session)
    assert "项目自定义规则" in rules
    assert module._system_prompt_for_display(session)==rules
    for prompt in (module._build_prompt(session),module._build_rebuild_prompt(session)):
        assert prompt.count("Current sender: Alice")==1
        assert "姓名：小研" not in prompt


async def test_identity_tone_persists_and_prompt_does_not_prescribe_reminders(setup,monkeypatch):
    from services import customization_workspace
    app,service=setup
    monkeypatch.setattr(customization_workspace,'is_default_workspace',lambda _:True)
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        profile=(await client.get('/api/digital-person')).json()
        profile.update(enabled=True,role='研发伙伴、项目管家',personality='严谨、耐心、自定义性格',tone='专业克制、自定义语气')
        result=await client.put('/api/digital-person',json=profile)
        assert result.status_code==200
        service.config_store._cache=None
        assert (await client.get('/api/digital-person')).json()['tone']=='专业克制、自定义语气'
        prompt=service.prompt_for_project(SimpleNamespace(id='home'))
        assert '角色：研发伙伴、项目管家' in prompt
        assert '性格：严谨、耐心、自定义性格' in prompt
        assert '语气：专业克制、自定义语气' in prompt
        assert '需要提醒时使用现有定时任务工具' not in prompt
        assert '结果核验完成后再回复来源会话' not in prompt
        assert (await client.put('/api/digital-person',json={**profile,'tone':'超'*1001})).status_code==422
