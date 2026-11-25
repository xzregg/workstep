"""Identity drafts persist separately from the effective persona until confirmation."""
from types import SimpleNamespace
import asyncio
import threading

import pytest
from httpx import ASGITransport, AsyncClient

from tests.test_digital_person import setup
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def test_identity_mutations_notify_host_clients_only_after_success(setup, monkeypatch):
    import main
    from streaming.ws import matches_subscription, parse_subscription
    app, service = setup
    published = []
    async def publish(event):
        published.append(event)
    monkeypatch.setattr(main.event_bus, 'publish', publish)
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        state = (await client.get('/api/digital-person/identity')).json()
        assert published == []
        assert (await client.post('/api/digital-person/identity', json={
            'action':'answer', 'revision':state['revision'], 'field':'name', 'value':'星河',
        })).status_code == 200
        assert published == [{'type':'CUSTOM', 'name':'workstep.digital_person_changed', 'value':{}}]
        event = published[0]
        assert matches_subscription(event, parse_subscription({'channels':['digital_person']}))
        assert not matches_subscription(event, parse_subscription({'project_id':'other', 'channels':['digital_person']}))
        assert (await client.post('/api/digital-person/identity', json={
            'action':'confirm', 'revision':state['revision'],
        })).status_code == 409
        assert len(published) == 1


async def test_cli_setup_resume_confirm_and_prompt(setup, monkeypatch):
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient
    app, service = setup
    monkeypatch.setattr('services.customization_workspace.is_default_workspace', lambda p: p.id == 'home')
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    client = WorkstepClient(transport=ASGITransport(app=app))
    async def command(*args):
        return await dispatch(build_parser().parse_args(['digital-hub', 'identity', *args, '--json']), client)
    state = await command('status')
    assert state['step'] == 'name'
    assert 'ONE question per turn' in service.identity_setup_prompt()
    assert 'automatically start or resume the current step' in service.identity_setup_prompt()
    original = service.get_profile().name
    for field, answer in [('name', '星河'), ('role', '研究助手'), ('personality', '温和、简洁'), ('duties', '整理研究资料')]:
        state = await command('answer', '--revision', state['revision'], '--field', field, '--value', answer)
        service.config_store.invalidate()
        assert service.get_profile().name == original
        assert (await command('status')) == state
    assert state['step'] == 'confirm' and state['summary']['name'] == '星河'
    saved = await command('confirm', '--revision', state['revision'])
    assert saved['status'] == 'completed'
    profile = service.get_profile()
    assert profile.name == '星河' and profile.onboarding_completed
    prompt = service.prompt_parts_for_project(SimpleNamespace(id='home'))
    assert '温和、简洁' in prompt['identity'] and '整理研究资料' in prompt['identity']
    assert 'identity_setup' not in prompt
    assert service.prompt_parts_for_project(SimpleNamespace(id='other')) == {}


async def test_legacy_reset_skip_and_stale_confirmation(setup):
    app, service = setup
    service.config_store.set('digital_person', {'enabled': True, 'name': '旧身份', 'persona_markdown': '原有完整人设'})
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        path = '/api/digital-person/identity'
        assert (await client.get(path)).json()['status'] == 'completed'
        state = (await client.post(path, json={'action': 'reset'})).json()
        assert service.get_profile().name == '旧身份'
        assert (await client.post(path, json={'action': 'confirm', 'revision': state['revision']})).status_code == 409
        for field in ('name', 'role', 'personality', 'duties'):
            response = await client.post(path, json={'action': 'answer', 'revision': state['revision'], 'field': field, 'skip': True})
            if field == 'name':
                assert response.status_code == 409
                response = await client.post(path, json={'action': 'answer', 'revision': state['revision'], 'field': field, 'value': '新身份'})
            state = response.json()
        assert state['summary']['persona_markdown'] == '原有完整人设'
        stale = state['revision']
        state = (await client.post(path, json={'action':'answer', 'revision':stale, 'field':'name', 'value':'最终名称'})).json()
        assert (await client.post(path, json={'action':'confirm', 'revision':stale})).status_code == 409
        assert (await client.post(path, json={'action':'confirm', 'revision':state['revision']})).status_code == 200
        assert service.get_profile().persona_markdown == '原有完整人设'


async def test_setup_failure_conflicts_and_validation_preserve_identity(setup, monkeypatch):
    from services import config
    app, service = setup
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        path = '/api/digital-person/identity'
        state = (await client.get(path)).json()
        answer = {'action':'answer','field':'name','value':'星河','revision':state['revision']}
        before = service.get_profile().model_dump()
        with monkeypatch.context() as failure:
            failure.setattr(config.os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('disk unavailable')))
            assert (await client.post(path,json=answer)).status_code == 503
            assert (await client.get(path)).json() == state
            assert service.get_profile().model_dump() == before
        state = (await client.post(path,json=answer)).json()
        for invalid in ({'value':'x'*201},{'value':' '},{'field':'unknown'},{'action':'execute'}):
            response = await client.post(path,json={**answer,'revision':state['revision'],**invalid})
            assert response.status_code in (409,422)
        state = (await client.post(path,json={'action':'answer','field':'duties','value':'提前表达的职责','revision':state['revision']})).json()
        assert state['step']=='role' and state['answers']['duties']=='提前表达的职责'
        for field in ('role','personality','duties'):
            state = (await client.post(path,json={'action':'answer','field':field,'skip':True,'revision':state['revision']})).json()
        with monkeypatch.context() as failure:
            failure.setattr(config.os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('disk unavailable')))
            assert (await client.post(path,json={'action':'confirm','revision':state['revision']})).status_code == 503
            assert service.get_profile().name == before['name']
            assert (await client.get(path)).json() == state
        # Saving other settings (even with a stale/forged setup payload) cannot erase progress.
        profile = service.get_profile().model_dump()
        profile.update(avatar='spark',identity_setup=None)
        assert (await client.put('/api/digital-person',json=profile)).status_code == 200
        assert (await client.get(path)).json() == state
        profile['name'] = '设置中的名字'
        await client.put('/api/digital-person',json=profile)
        assert (await client.get(path)).json()['conflict']
        assert (await client.post(path,json={'action':'confirm','revision':state['revision']})).status_code == 409
        service.config_store.invalidate()
        assert service.get_profile().name == '设置中的名字'


async def test_setup_slow_disk_keeps_health_responsive(setup, monkeypatch):
    app, service = setup
    entered, release = threading.Event(), threading.Event()
    original = service.config_store._save
    def slow_save():
        entered.set()
        assert release.wait(3)
        original()
    monkeypatch.setattr(service.config_store, '_save', slow_save)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/digital-person/identity',json={'action':'reset'}))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code == 200
        finally:
            release.set()
            assert (await pending).status_code == 200


@pytest.mark.parametrize('policy_state',['missing','denied','project'])
async def test_identity_setup_host_authorization(setup, monkeypatch, policy_state):
    import main
    from services.remote_access import ActorSnapshot, actor_context
    from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot
    from tests.test_gateway_policy import _signed_policy
    app, service = setup
    cache = ManagedPolicyCache()
    if policy_state == 'denied':
        token,pem,fingerprint = _signed_policy(engine_install=False,allow_local_providers=False)
        cache.apply(verify_policy_snapshot(token,pem,fingerprint,'gateway-test','device-1','user-1'))
    monkeypatch.setattr(main,'gateway_client',SimpleNamespace(managed_config=object(),policy_cache=cache))
    actor = ActorSnapshot('user-1','Alice','device-1','PC','remote_project' if policy_state=='project' else 'managed',project_id='other' if policy_state=='project' else None,access_level='edit')
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
            expected = 403 if policy_state == 'project' else 200
            assert (await client.get('/api/digital-person/identity')).status_code == expected
            assert (await client.post('/api/digital-person/identity',json={'action':'reset'})).status_code == expected
    if policy_state == 'project':
        assert service.get_profile().identity_setup is None


async def test_main_conversation_injects_live_setup_and_isolates_ordinary_chat(runtime, monkeypatch):
    from services import digital_person as service
    from tests.test_chat_role_binding import install_engine, send
    current, project, store = runtime
    # The runtime fixture supplies the real host project and chat/database services.
    store.set('digital_person',{})
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    sid = (await current.main_session())['id']
    calls, _ = install_engine(current.chats,monkeypatch)
    assert await send(current.chats,project,sid,'你好') == 'completed'
    assert '## Identity setup' in calls[-1] and '"step": "name"' in calls[-1]
    state = service.identity_setup_status()
    await asyncio.to_thread(service.update_identity_setup,service.IdentitySetupCommand(action='answer',field='name',value='星河',revision=state['revision']))
    assert await send(current.chats,project,sid,'继续') == 'completed'
    assert '"step": "role"' in calls[-1] and '星河' in calls[-1]
    for field in ('role','personality','duties'):
        state = service.identity_setup_status()
        await asyncio.to_thread(service.update_identity_setup,service.IdentitySetupCommand(action='answer',field=field,skip=True,revision=state['revision']))
    state = service.identity_setup_status()
    await asyncio.to_thread(service.update_identity_setup,service.IdentitySetupCommand(action='confirm',revision=state['revision']))
    assert await send(current.chats,project,sid,'确认后继续交流') == 'completed'
    assert 'Name: 星河' in calls[-1] and 'Already initialized; do not start setup automatically.' in calls[-1]
    other = await current.projects.run_db(project.id,lambda _:current.chats.create_session(project.id))
    assert await send(current.chats,project,other['id'],'普通对话') == 'completed'
    assert '## Identity setup' not in calls[-1]


@pytest.mark.parametrize('legacy,expected',[
    ({'enabled':True},'completed'),
    ({'onboarding_completed':True},'completed'),
    ({'enabled':False,'name':'定制身份'},'completed'),
    ({'persona_markdown':'用户旧版人设'},'completed'),
    ({'enabled':False},'pending'),
])
def test_legacy_identity_detection_is_conservative(setup,legacy,expected):
    _,service = setup
    service.config_store.set('digital_person',legacy)
    assert service.identity_setup_status()['status'] == expected
    service.save_profile(service.get_profile().model_copy(update={'enabled':True}))
    assert service.identity_setup_status()['status'] == expected


def test_new_persona_explicitly_replaces_document_and_tone_only_on_confirmation(setup):
    _,service = setup
    service.config_store.set('digital_person',{'enabled':True,'persona_markdown':'旧人设','tone':'旧语气'})
    state = service.update_identity_setup(service.IdentitySetupCommand(action='reset'))
    for field,value in [('name','星河'),('role','新角色'),('personality','温柔简洁'),('duties','研究资料')]:
        state = service.update_identity_setup(service.IdentitySetupCommand(action='answer',field=field,value=value,revision=state['revision']))
    assert service.get_profile().persona_markdown == '旧人设'
    assert state['summary']['persona_markdown'] is None and state['summary']['tone'] == ''
    service.update_identity_setup(service.IdentitySetupCommand(action='confirm',revision=state['revision']))
    assert service.get_profile().persona_markdown is None and service.get_profile().tone == ''


async def test_interview_collects_out_of_order_and_pauses_durably(setup):
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient
    app,service = setup
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    client = WorkstepClient(transport=ASGITransport(app=app))
    async def command(*args):
        return await dispatch(build_parser().parse_args(['digital-hub','identity',*args,'--json']),client)
    state = await command('status')
    state = await command('collect','--revision',state['revision'],'--duties','会议整理、资料检索，并可补充写作')
    assert state['step'] == 'name'
    assert state['answers']['duties'].endswith('补充写作')
    state = await command('collect','--revision',state['revision'],'--name','星河','--role','工作伙伴','--personality','温和、严谨；先给结论')
    assert state['step'] == 'confirm' and service.get_profile().name != '星河'
    assert '先给结论' in state['summary']['personality']
    reviewed = state['revision']
    state = await command('pause','--revision',reviewed)
    service.config_store.invalidate()
    assert (await command('status')) == state and state['paused']
    assert 'Do not restart, ask setup questions or collect answers' in service.identity_setup_prompt()
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as http:
        assert (await http.post('/api/digital-person/identity',json={'action':'confirm','revision':state['revision']})).status_code == 409
    state = await command('resume','--revision',state['revision'])
    assert not state.get('paused') and state['step']=='confirm'
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as http:
        assert (await http.post('/api/digital-person/identity',json={'action':'confirm','revision':reviewed})).status_code == 409
    state = await command('answer','--revision',state['revision'],'--field','role','--value','项目秘书')
    assert state['summary']['role']=='项目秘书' and state['revision'] != reviewed
    await command('confirm','--revision',state['revision'])
    assert service.get_profile().role=='项目秘书'
    assert '先给结论' in service.get_profile().personality


async def test_interview_batch_validation_is_atomic(setup):
    app,service = setup
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    state = service.identity_setup_status()
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        for answers in ({'name':'星河','role':'x'*201},{'name':'星河','health':'不要采集'}, {'name':' '}):
            response=await client.post('/api/digital-person/identity',json={'action':'answer','revision':state['revision'],'answers':answers})
            assert response.status_code in (409,422)
            assert service.identity_setup_status()==state
        response=await client.post('/api/digital-person/identity',json={'action':'answer','revision':state['revision'],'answers':{'duties':'资料检索'},'field':'name','value':'星河'})
        assert response.status_code in (409,422)
        assert service.identity_setup_status()==state


async def test_interview_menus_are_bounded_suggestions_not_value_restrictions(setup):
    app,service = setup
    service.save_profile(service.DigitalPersonProfile(enabled=True))
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        state=(await client.get('/api/digital-person/identity')).json()
        expected={'role':['Personal assistant','Work partner','Project secretary','Knowledge advisor'],
                  'personality':['Gentle','Efficient','Lively','Rigorous'],
                  'duties':['Schedule reminders','Project follow-up','Information research','Document organization']}
        for field,labels in expected.items():
            menu=state['menus'][field]
            assert [option['label'] for option in menu['options']]==labels
            assert [option['id'] for option in menu['options']]==['1','2','3','4']
            assert menu['multiple']==(field!='role') and menu['free_text']
        response=await client.post('/api/digital-person/identity',json={'action':'answer','revision':state['revision'],
            'answers':{'name':'澄知','role':'自由补充的策划伙伴','personality':'温和、严谨；先给结论','duties':'资料检索和会议纪要，需明确交代后执行'}})
        assert response.status_code==200 and response.json()['step']=='confirm'
        assert 'menus' not in service.config_store.get('digital_person')['identity_setup']
