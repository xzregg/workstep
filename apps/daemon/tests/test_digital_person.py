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
    from services.speech_output import SpeechOutputService
    from services.wake_audio import WakeAudioCache
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config.config_store, "_cache", None)
    monkeypatch.setattr(service, "config_store", config.config_store)
    monkeypatch.setattr(digital_person, "wake_audio", WakeAudioCache(tmp_path / 'wake-audio.json', SpeechOutputService(tmp_path)))
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
        assert original["proactive_shared_context"] is True
        assert original['reflection_enabled'] is True
        assert original['memory_batch_size'] == 100
        payload = {**original, "enabled": True, "reflection_enabled":False, "name": "小研", "duties": "跟进研发", "personality": "直接", "proactive_shared_context": False}
        response = await client.put("/api/digital-person", json=payload)
        assert response.status_code == 200
        service.config_store._cache = None
        saved = (await client.get("/api/digital-person")).json()
        assert saved["duties"] == "跟进研发"
        assert saved["proactive_shared_context"] is False
        assert saved['reflection_enabled'] is False and saved['enabled'] is True
        assert (await client.put("/api/digital-person", json={**payload, "name": "   "})).status_code == 422
        assert (await client.put("/api/digital-person", json={**payload, "workspace": "/tmp"})).status_code == 422
        assert (await client.put('/api/digital-person', json={**payload, 'memory_batch_size': 60})).status_code == 200
        service.config_store._cache = None
        assert (await client.get('/api/digital-person')).json()['memory_batch_size'] == 60
        for size in (0, 1001, 1.5):
            assert (await client.put('/api/digital-person', json={**payload, 'memory_batch_size': size})).status_code == 422


async def test_personal_check_interval_and_conversation_rules(setup, monkeypatch):
    from services import customization_workspace
    app, service = setup
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda p: p.id == 'home')
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        payload = (await client.get('/api/digital-person')).json()
        payload.update(enabled=True, reflection_enabled=False, proactive_interval_minutes=15, conversation_rules='先给结论，再解释依据')
        assert (await client.put('/api/digital-person', json=payload)).status_code == 200
        service.config_store._cache = None
        assert (await client.get('/api/digital-person')).json()['proactive_interval_minutes'] == 15
        assert '先给结论，再解释依据' in service.prompt_for_project(SimpleNamespace(id='home'))
        assert service.prompt_for_project(SimpleNamespace(id='other')) == ''
        for interval in (0, 1441, 1.5):
            assert (await client.put('/api/digital-person', json={**payload, 'proactive_interval_minutes': interval})).status_code == 422


async def test_standing_memory_append_preserves_profile_and_deduplicates(setup, monkeypatch):
    from services import customization_workspace
    app, service = setup
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda _: True)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        profile = {'enabled': True, 'name': '小研', 'conversation_rules': '## 长期约定\n- 简洁回复'}
        assert (await client.put('/api/digital-person', json=profile)).status_code == 200
        path = '/api/digital-person/standing-memory'
        rules = ['以后给方案，先给我看原型', '先说结论']
        responses = await asyncio.gather(*(client.post(path, json={'rule': rule}) for rule in rules))
        assert all(r.status_code == 200 and r.json() == {'saved': True, 'added': True} for r in responses)
        assert (await client.post(path, json={'rule': rules[0]})).json() == {'saved': True, 'added': False}
        for invalid in ('  ', '两条\n规则', '过' * 8001):
            assert (await client.post(path, json={'rule': invalid})).status_code == 422
        service.config_store.invalidate()
        saved = (await client.get('/api/digital-person')).json()
        assert saved['name'] == '小研'
        assert saved['conversation_rules'].startswith(profile['conversation_rules'])
        for rule in rules:
            assert saved['conversation_rules'].count(rule) == 1
            assert rule in service.prompt_for_project(SimpleNamespace())
        assert (await client.post(path, json={'rule': '长' * 8000})).status_code == 409
        assert (await client.get('/api/digital-person')).json() == saved


async def test_standing_memory_slow_save_and_failed_write(setup, monkeypatch):
    app, service = setup
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    entered, release = threading.Event(), threading.Event()
    def fail_write():
        entered.set()
        assert release.wait(3)
        raise OSError('disk full')
    monkeypatch.setattr(service.config_store, '_save', fail_write)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/digital-person/standing-memory', json={'rule': '先看原型'}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .5)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 503
        assert (await client.get('/api/digital-person')).json()['conversation_rules'] == ''


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
            assert (await client.post("/api/digital-person/standing-memory", json={'rule': '先看原型'})).status_code == 403
            assert (await client.get("/api/digital-person/voice-wake")).status_code == 403
            assert (await client.get("/api/digital-person/voice-wake/audio")).status_code == 403
            assert (await client.put("/api/digital-person/voice-wake", json={})).status_code == 403


def test_person_prompt_only_in_fixed_workspace_and_when_enabled(setup, monkeypatch):
    from services import customization_workspace
    from services.digital_person import DigitalPersonProfile
    _, service = setup
    monkeypatch.setattr(customization_workspace, "is_default_workspace", lambda p: p.id == "home")
    home, other = SimpleNamespace(id="home"), SimpleNamespace(id="other")
    profile = DigitalPersonProfile(enabled=True, name="小研", duties="复查证据", personality="直接")
    service.save_profile(profile)
    prompt = service.prompt_for_project(home)
    assert "复查证据" in prompt
    assert "\n\n## Memory retrieval\nFor historical recall" in prompt
    assert "\n\n## Everyday conversation\nAnswer everyday requests directly" in prompt
    assert "\n\n## Project delegation\nHARD BOUNDARY: Never modify code" in prompt
    assert "workstep-cli skill" in prompt
    assert 'historical recall, stored knowledge, or user preferences' in prompt
    assert 'workstep-cli memory' in prompt and 'references/memory.md' in prompt
    assert 'digital-person remember' in prompt and 'schedule create' in prompt
    assert 'For overviews, omit --with-sources' in prompt
    assert "HARD BOUNDARY" in prompt
    assert "Answer everyday requests directly" in prompt
    assert "checking the time or weather, casual conversation, and writing poems" in prompt
    assert "Prefer short sentences or a simple list" in prompt
    assert "Use Markdown tables only when the user requests one or a side-by-side comparison materially improves clarity" in prompt
    assert "read-only lookups" in prompt
    assert "Never modify code or create, edit, or delete files in this conversation" in prompt
    assert "MUST run in a separate execution session" in prompt
    assert "For one-off project work, delegate directly to an execution conversation" in prompt
    assert "Create a workflow only when the user explicitly asks for one" in prompt
    assert "Before delegating, determine which project should own the work" in prompt
    assert "Honor the user's explicit project choice" in prompt
    assert "ask the user which project to use and wait before creating the execution session" in prompt
    assert "continue it in the existing execution conversation" in prompt
    assert "tracked delegation with --target-session" in prompt
    assert "queue the new instruction without interrupting the current turn" in prompt
    assert "If unsure whether to continue a prior task or start a new one, ask the user and wait" in prompt
    assert "If delegation fails, report the blocker" in prompt
    assert "workstep digital-person delegate" not in prompt
    assert "workstep project list" not in prompt
    assert "workstep context get" not in prompt
    assert "workstep_delegate_digital_person" not in prompt
    assert service.prompt_for_project(other) == ""
    service.save_profile(profile.model_copy(update={"enabled": False}))
    assert service.prompt_for_project(home) == ""


async def test_identity_reaches_engine_changes_on_resume_and_does_not_pollute_settings(chat_module, monkeypatch):
    from tests.test_chat_role_binding import install_engine, send
    from services.digital_person import DigitalPersonProfile, StandingMemoryDraft, append_standing_memory, save_profile
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
    save_profile(DigitalPersonProfile(enabled=True, duties="IDENTITY UPDATED"))
    assert await asyncio.to_thread(append_standing_memory, StandingMemoryDraft(rule="RULE UPDATED"))
    assert await send(module, project, sid, 'changed') == 'completed'
    assert 'IDENTITY UPDATED' in calls[-1] and 'IDENTITY ORIGINAL' not in calls[-1]
    assert 'RULE UPDATED' in calls[-1]
    save_profile(DigitalPersonProfile(enabled=False))
    assert await send(module, project, sid, 'off') == 'completed'
    assert 'Digital person mode is disabled' in calls[-1] and 'IDENTITY UPDATED' not in calls[-1]


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


async def test_wake_audio_is_generated_on_save_and_reused_by_another_client(setup, tmp_path, monkeypatch):
    from api import digital_person
    from services.wake_audio import WakeAudioCache

    app, service = setup
    release = asyncio.Event()
    generated = []

    class Speech:
        async def settings(self):
            return {'mode': 'cloud', 'voice': 'sample', 'rate': 1, 'volume': 1}

        async def start(self, project, owner, text, *, settings_snapshot):
            generated.append(text)
            return {'id': 'wake'}

        async def next(self, sid, project, owner):
            await release.wait()
            return {'done': True, 'audio': 'AAA=', 'format': 'pcm', 'sample_rate': 24000}

        async def cancel(self, sid, project, owner):
            pass

    speech = Speech()
    cache = WakeAudioCache(tmp_path / 'wake-audio.json', speech)
    monkeypatch.setattr(digital_person, 'wake_audio', cache)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://desktop') as desktop:
        response = await desktop.put('/api/digital-person/voice-wake', json={
            'keyword': '你好小研', 'sound_enabled': True, 'greeting': '我在，您说',
        })
        assert response.status_code == 200
        assert (await desktop.get('/api/digital-person/voice-wake/audio')).json()['status'] == 'pending'
        assert generated == ['我在，您说']
        release.set()
        await cache.task
        assert (await desktop.put('/api/digital-person/voice-wake', json={'keyword': '小研你好'})).status_code == 200

    service.config_store.invalidate()
    monkeypatch.setattr(digital_person, 'wake_audio', WakeAudioCache(tmp_path / 'wake-audio.json', speech))
    async with AsyncClient(transport=ASGITransport(app), base_url='http://phone') as phone:
        config = (await phone.get('/api/digital-person/voice-wake')).json()
        assert config['greeting'] == '我在，您说' and config['sound_enabled']
        audio = (await phone.get('/api/digital-person/voice-wake/audio')).json()
        assert audio['status'] == 'ready'
        assert audio['chunks'] == [{'audio': 'AAA=', 'format': 'pcm', 'sampleRate': 24000}]
        assert generated == ['我在，您说']
        release.clear()
        assert (await phone.put('/api/digital-person/voice-wake', json={'greeting': '您好'})).status_code == 200
        pending = (await phone.get('/api/digital-person/voice-wake/audio')).json()
        assert pending == {'status': 'pending', 'text': '您好'}
        release.set()
        await digital_person.wake_audio.task
        assert (await phone.get('/api/digital-person/voice-wake/audio')).json()['text'] == '您好'
        assert generated == ['我在，您说', '您好']
        assert (await phone.put('/api/digital-person/voice-wake', json={'sound_enabled': False})).status_code == 200
        assert (await phone.get('/api/digital-person/voice-wake/audio')).json()['status'] == 'none'
        assert not (tmp_path / 'wake-audio.json').exists()


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
        assert "Name: 小研" in rules
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
        assert "Name: 小研" not in prompt


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
        assert 'Role: 研发伙伴、项目管家' in prompt
        assert 'Personality: 严谨、耐心、自定义性格' in prompt
        assert 'Tone: 专业克制、自定义语气' in prompt
        assert '需要提醒时使用现有定时任务工具' not in prompt
        assert '结果核验完成后再回复来源会话' not in prompt
        assert (await client.put('/api/digital-person',json={**profile,'tone':'超'*1001})).status_code==422


async def test_delegation_poll_interval_persists_and_validates_seconds(setup):
    app,service=setup
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        profile=(await client.get('/api/digital-person')).json()
        assert profile['delegation_interval_seconds']==60
        response=await client.put('/api/digital-person',json={**profile,'delegation_interval_seconds':3})
        assert response.status_code==200
        service.config_store._cache=None
        saved=(await client.get('/api/digital-person')).json()
        assert saved['delegation_interval_seconds']==3
        assert saved['proactive_interval_minutes']==5
        for value in (0,301,1.5):
            assert (await client.put('/api/digital-person',json={**profile,'delegation_interval_seconds':value})).status_code==422


async def test_contact_interval_api_is_independent_bounded_and_persistent(setup):
    app,service=setup
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        original=(await client.get('/api/digital-person')).json()
        assert original['proactive_contact_interval_minutes']==5
        payload={**original,'proactive_contact_interval_minutes':30}
        assert (await client.put('/api/digital-person',json=payload)).status_code==200
        service.config_store._cache=None
        saved=(await client.get('/api/digital-person')).json()
        assert saved['proactive_contact_interval_minutes']==30
        assert saved['proactive_interval_minutes']==5
        for invalid in (0,1441):
            assert (await client.put('/api/digital-person',json={**payload,'proactive_contact_interval_minutes':invalid})).status_code==422


async def test_markdown_identity_roundtrip_and_prompt_uses_documents(setup, monkeypatch):
    from services import customization_workspace
    app, service = setup
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda _: True)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        payload=(await client.get('/api/digital-person')).json()
        payload.update(enabled=True, persona_markdown='## 身份\n私人助理\n\n## 性格\n- 耐心',
                       duties='## 职责\n- 跟进事项',conversation_rules='## 长期约定\n- 先看原型')
        result=await client.put('/api/digital-person',json=payload)
        assert result.status_code==200
        service.config_store._cache=None
        saved=(await client.get('/api/digital-person')).json()
        assert saved['persona_markdown']==payload['persona_markdown']
        text=service.prompt_for_project(SimpleNamespace(id='home'))
        assert payload['persona_markdown'] in text and payload['duties'] in text
        assert payload['conversation_rules'] in text and 'HARD BOUNDARY' in text
        assert 'Duties: ##' not in text and 'Conversation rules: ##' not in text
        assert '\n\n'+payload['duties']+'\n\n' in text
        from services.digital_person_assessment import instruction
        background=instruction(service.get_profile())
        assert payload['persona_markdown'] in background and payload['conversation_rules'] in background
        assert 'Personality: '+payload['personality'] not in text
        assert (await client.put('/api/digital-person',json={**payload,'persona_markdown':'x'*16001})).status_code==422


def test_prompt_omits_only_previous_generated_boundary_and_preserves_custom_markdown(setup, monkeypatch):
    from services import customization_workspace
    from services.digital_person import DigitalPersonProfile
    _, service = setup
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda _: True)
    old='## 主要职责\n- 跟进事项\n\n## 执行红线\n实际工作必须交给项目执行会话，绝不亲自执行。指派后立即返回，由后台跟进。'
    service.save_profile(DigitalPersonProfile(enabled=True,persona_markdown='## 身份\n助理',duties=old))
    text=service.prompt_for_project(SimpleNamespace(id='home'))
    assert '## 主要职责\n- 跟进事项' in text
    assert '## 执行红线' not in text
    assert text.count('HARD BOUNDARY')==1
    custom=old.replace('实际工作必须交给项目执行会话，绝不亲自执行。指派后立即返回，由后台跟进。','不得发布未经核验的结果。')
    service.save_profile(DigitalPersonProfile(enabled=True,persona_markdown='## 身份\n助理',duties=custom))
    assert custom in service.prompt_for_project(SimpleNamespace(id='home'))
