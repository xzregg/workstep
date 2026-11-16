import asyncio
import threading
from httpx import AsyncClient, ASGITransport
from tests.test_chat_session import chat_module


async def test_camera_context_reaches_engine_system_prompt_and_clears_next_turn(chat_module, monkeypatch, tmp_path):
    from services import config, face_recognition as faces
    module, _, manager, project, _ = chat_module
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path / 'face-config')
    faces.save_settings(faces.Settings(enabled=True))
    person = faces.create(faces.Enrollment(name='小谢', relationship='主人', consent=True, embeddings=[[.1]*1024]*3))
    image = '.workstep/uploads/digital-person-camera-1.jpg'
    unknown_image = '.workstep/uploads/digital-person-camera-unknown.jpg'
    original_prompt = faces.person_prompt
    entered, release = threading.Event(), threading.Event()
    def slow_prompt(*args):
        entered.set()
        assert release.wait(2)
        return original_prompt(*args)
    monkeypatch.setattr(faces, 'person_prompt', slow_prompt)
    calls = []
    async def invoke(*args, **kwargs):
        calls.append((args[3], kwargs))
        return '收到', [], 'camera-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    import main
    monkeypatch.setattr(main, 'project_manager', manager)
    monkeypatch.setattr(main, 'chat_session_module', module)
    sid = module.create_session(project.id)['id']
    body = f'我叫什么名啊\n\n![camera.jpg]({image})'
    messages = [body, '下一轮没有摄像头', f'看到了谁？\n\n![]({unknown_image})',
                '没有登记的图片\n\n![](.workstep/uploads/digital-person-camera-missing.jpg)']
    for index, text in enumerate(messages):
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            response = await client.post(f'/api/chat-sessions/{sid}/chat',
                headers={'Idempotency-Key':f'face-{index}'},
                json={'project_id':project.id,'content':text,'face_person_ids':[person['id']] if index==0 else []})
            assert response.status_code == 200, response.text
            turn_id = response.json()['turn_id']
        if index == 0:
            try:
                assert await asyncio.to_thread(entered.wait, 1)
                assert await asyncio.wait_for(asyncio.sleep(0, result=True), .2)
            finally:
                release.set()
        await module.await_turn(turn_id, timeout=5)
        if index == 0:
            # Simulate loss of transient extra state after native session recovery.
            for session in module._sessions.values():
                session.extra.pop('camera_context_each_turn', None)
                session.extra.pop('camera_frame_prompt', None)
    assert len(calls) == 4
    assert '小谢' in calls[0][1]['system_prompt'] and '主人' in calls[0][1]['system_prompt']
    assert '小谢' not in calls[0][0]
    assert calls[0][1]['system_prompt_each_turn'] is True
    assert '人脸识别到用户：用户名：小谢；关系：主人。' in calls[0][1]['system_prompt']
    assert 'Camera observation' not in calls[0][1]['system_prompt']
    for _, options in calls[1:]:
        system = options.get('system_prompt', '')
        assert all(text not in system for text in ['人脸识别', 'Camera observation', '小谢', 'No camera observation', 'unknown_face_count'])
    assert calls[1][1]['system_prompt_each_turn'] is True
    detail = await manager.run_db(project.id, lambda _: module.get_session(project.id, sid))
    assert [m['content'] for m in detail['messages'] if m['role'] == 'user'] == messages
    from models.chat_session import ChatMessage
    import json
    stored = await manager.run_db(project.id, lambda _: [json.loads(m.context_json or '{}') for m in ChatMessage.select().where(ChatMessage.session == sid, ChatMessage.role == 'user').order_by(ChatMessage.created_at)])
    assert stored[0] == {'face_person_ids':[person['id']]}
    assert stored[1:] == [{}, {}, {}]
    from services.remote_access import ActorSnapshot, actor_context
    actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d', source='remote_project', project_id=project.id, access_level='edit')
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            denied = await client.post(f'/api/chat-sessions/{sid}/chat', headers={'Idempotency-Key':'unauthorized-face'}, json={'project_id':project.id,'content':'谁','face_person_ids':[person['id']]})
            assert denied.status_code == 403
