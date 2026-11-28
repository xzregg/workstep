from tests.prompt_xml import read_context
import asyncio
from pathlib import Path
import time

import pytest
from agent_assistants.prototype import PrototypeModule
from services.project import ProjectManager
from services.prototype_workspace import PrototypeWorkspace
from services.remote_access import ActorSnapshot, actor_context
from streaming.bus import EventBus


@pytest.fixture
async def prototype(tmp_path, monkeypatch):
    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'prototype-project')
    (project.path / 'index.html').write_text('<button>Before</button>')
    (project.path / 'other.html').write_text('<p>Other</p>')
    work = PrototypeWorkspace.open(project.path, project.workstep_dir, project.path / 'index.html')
    bus = EventBus()
    module = PrototypeModule(bus, manager)
    monkeypatch.setattr(module, '_resolve_engine_models', lambda: ('claude', None, None))
    with actor_context(ActorSnapshot('u','Tester','d','Device','local')):
        yield module, manager, project, work, bus
    await module.shutdown()
    await bus.close()
    manager.close_all()


async def test_real_runtime_edit_history_and_document_isolation(prototype, monkeypatch):
    module, manager, project, work, bus = prototype
    seen = []
    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        from services.project_storage import data_directory
        seen.append((cwd, prompt, data_directory(cwd)))
        await asyncio.to_thread((Path(cwd) / 'index.html').write_text, '<button>After</button>')
        return '已调整按钮', [], 'engine-test-session'
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '修改按钮', 'request-1'))
    module.start_queued_turn(accepted.turn_id)
    await asyncio.wait_for(module._turn_tasks[accepted.turn_id], 5)
    from models import Task
    assert await manager.run_db(project.id,lambda _:Task.select().count()) == 0
    assert work.state()['status'] == 'idle'
    assert (project.path / 'index.html').read_text() == '<button>After</button>'
    assert seen[0][0] == str(work.directory / 'workspace')
    assert seen[0][2] == project.workstep_dir
    document_id = work.load()['documents']['index.html']
    history = await manager.run_db(project.id, lambda _: module.history(project.id, document_id))
    assert any(message['content'] == '修改按钮' for message in history['messages'])
    other = work.load()['documents']['other.html']
    assert await manager.run_db(project.id, lambda _: module.history(project.id, other)) is None
    restored = PrototypeModule(bus, manager)
    again = await manager.run_db(project.id, lambda _: restored.history(project.id, document_id))
    assert again['engine_session_id'] == 'engine-test-session'
    await restored.shutdown()


async def test_failed_engine_keeps_original_and_work_copy(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    async def invoke(*args, **kwargs):
        await asyncio.to_thread((work.directory / 'workspace/index.html').write_text, 'partial')
        raise RuntimeError('simulated engine interruption')
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '修改按钮', 'request-2'))
    module.start_queued_turn(accepted.turn_id)
    await asyncio.wait_for(module._turn_tasks[accepted.turn_id], 5)
    assert work.state()['status'] == 'interrupted'
    assert (project.path / 'index.html').read_text() == '<button>Before</button>'
    assert (work.directory / 'workspace/index.html').read_text() == 'partial'


async def test_slow_history_db_does_not_block_loop(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    original = module._config.persistence.load_history
    def slow(*args):
        time.sleep(.15)
        return original(*args)
    monkeypatch.setattr(module._config.persistence, 'load_history', slow)
    request = asyncio.create_task(manager.run_db(project.id, lambda _: module.history(project.id, work.load()['documents']['index.html'])))
    await asyncio.sleep(.02)
    start = time.monotonic()
    await asyncio.sleep(.01)
    assert time.monotonic() - start < .08
    await request


async def test_publish_conflict_is_a_persisted_failed_turn(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    async def invoke(*args, **kwargs):
        await asyncio.to_thread((work.directory / 'workspace/index.html').write_text, '<p>model</p>')
        await asyncio.to_thread((project.path / 'index.html').write_text, '<p>external</p>')
        return '修改完成', [], 'engine-id'
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '改字', 'conflict'))
    module.start_queued_turn(accepted.turn_id)
    await module._turn_tasks[accepted.turn_id]
    assert module._turn_states[accepted.turn_id]['status'] == 'error'
    assert work.state()['status'] == 'conflict'
    assert (project.path / 'index.html').read_text() == '<p>external</p>'
    doc = work.load()['documents']['index.html']
    history = await manager.run_db(project.id, lambda _: module.history(project.id, doc))
    assert history['messages'][-1]['status'] == 'error'


async def test_stop_preserves_draft_and_finalizes_session(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    ready = asyncio.Event()
    async def invoke(*args, **kwargs):
        await asyncio.to_thread((work.directory / 'workspace/index.html').write_text, 'partial')
        ready.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '改字', 'stop'))
    module.start_queued_turn(accepted.turn_id)
    await asyncio.wait_for(ready.wait(), 3)
    await module.stop_current(accepted.session_id)
    task = module._turn_tasks.get(accepted.turn_id)
    if task:
        await task
    assert module._turn_states[accepted.turn_id]['status'] == 'stopped'
    assert work.state()['status'] == 'interrupted'
    assert (project.path / 'index.html').read_text() == '<button>Before</button>'


async def test_selected_element_is_visible_in_history_and_exact_in_engine_context(prototype, monkeypatch):
    import json
    module, manager, project, work, _ = prototype
    (project.path / 'index.html').write_text('<p>08</p>\n<p>本周新增 2 个</p>')
    work.refresh_sources()
    version = work.document('index.html').version
    selected = {'node_id':'n1','version':version,'tag':'p','text':'08','classes':'stat-value'}
    seen = []
    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        context = read_context(prompt, 'editing_context')
        seen.append(context)
        assert prompt.endswith('<user_request>\n改成9\n</user_request>\n')
        assert '> `index.html:1`' not in prompt
        assert context['selection']['source_location']['source'] == '<p>08</p>'
        await asyncio.to_thread((Path(cwd) / 'index.html').write_text, '<p>9</p>\n<p>本周新增 2 个</p>')
        return '已修改选中元素', [], 'selection-engine'
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '改成9', 'selected', selection=selected))
    module.start_queued_turn(accepted.turn_id)
    await module._turn_tasks[accepted.turn_id]
    assert (project.path / 'index.html').read_text() == '<p>9</p>\n<p>本周新增 2 个</p>'
    assert work.document('index.html').version != version
    document_id = work.load()['documents']['index.html']
    history = await manager.run_db(project.id, lambda _: module.history(project.id, document_id))
    user = next(message for message in history['messages'] if message['role'] == 'user')
    assert 'index.html:1' in user['content']
    assert 'n1' in user['content']
    assert '08' in user['content']
    assert '改成9' in user['content']


async def test_prompt_includes_only_current_page_dependencies_and_compact_location(prototype):
    import json
    from types import SimpleNamespace
    module, _, project, work, _ = prototype
    page = project.path / 'pages/sample.html'
    page.parent.mkdir()
    page.write_text('<link href="../shared.css">\n<p>08</p>')
    (page.parent / 'unrelated.html').write_text('<p>Unrelated sibling</p>')
    (project.path / 'shared.css').write_text('@import "colors.css";')
    (project.path / 'colors.css').write_text('p{color:blue}')
    work = PrototypeWorkspace.open(project.path, project.workstep_dir, page)
    selected = {'node_id':'n2','version':work.document('pages/sample.html').version,'tag':'p','text':'08',
                'rect':{'x':100,'y':200},'styles':{'color':'blue'},'selector':'p:nth-of-type(1)'}
    session = SimpleNamespace(project_id=project.id, engine='claude', messages=[{'role':'user','content':'改成9'}],
        extra={'workspace_id':work.id,'path':'pages/sample.html','selection':selected})
    prompt = await asyncio.to_thread(module._prototype_prompt, session)
    context = read_context(prompt, 'editing_context')
    assert context['current_file'] == 'sample.html'
    assert set(context['related_files']) == {'../shared.css','../colors.css'}
    assert context['selection']['source_location'] == {'line':2,'source':'<p>08</p>'}
    assert set(context['selection']) == {'node_id','source_location','selector','text'}
    assert context['selection']['selector'] == 'p:nth-of-type(1)'
    assert context['selection']['text'] == '08'
    assert 'version' not in context
    assert prompt.count('改成9') == 1
    assert 'rect' not in context['selection']
    assert 'version' not in context['selection']
    assert len(prompt) < 900


async def test_minimal_prompt_without_selection_keeps_existing_session_untouched(prototype):
    import json
    from types import SimpleNamespace
    module, _, project, work, _ = prototype
    messages=[{'role':'user','content':'之前的要求'}, {'role':'assistant','content':'已有回复','prompt':'old full prompt'}, {'role':'user','content':'调整布局'}]
    session=SimpleNamespace(project_id=project.id,engine='claude',resolved_session_id='existing-engine',
        engine_state={'keep':'history'},messages=messages,
        extra={'workspace_id':work.id,'path':'index.html'})
    before=json.dumps(messages,ensure_ascii=False)
    prompt=await asyncio.to_thread(module._prototype_prompt,session)
    context=read_context(prompt, 'editing_context')
    assert context=={'current_file':'index.html'}
    assert len(prompt)<150
    assert session.resolved_session_id=='existing-engine'
    assert session.engine_state=={'keep':'history'}
    assert json.dumps(messages,ensure_ascii=False)==before


async def test_nested_frame_context_keeps_actual_file_and_short_frame_location(prototype):
    import json
    from types import SimpleNamespace
    module,_,project,work,_=prototype
    version=work.document('other.html').version
    selected={'node_id':'n1','version':version,'frame_path':[{'file':'index.html','selector':'iframe#content'}]}
    session=SimpleNamespace(project_id=project.id,engine='claude',messages=[{'role':'user','content':'改子页面'}],extra={'workspace_id':work.id,'path':'other.html','selection':selected})
    prompt=await asyncio.to_thread(module._prototype_prompt,session)
    context=read_context(prompt, 'editing_context')
    assert context['current_file']=='other.html'
    assert context['selection']['frame_path']==[{'file':'index.html','selector':'iframe#content'}]
    assert context['selection']['source_location']['source']=='<p>Other</p>'
