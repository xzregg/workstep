import asyncio
import threading

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def faces(tmp_path, monkeypatch):
    from services import config, face_recognition
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    face_recognition.save_settings(face_recognition.Settings(enabled=True))
    return face_recognition


def sample():
    return [0.1] * 1024


def person(faces):
    return faces.create(faces.Enrollment(name='小张', relationship='朋友', consent=True,
        model_version=faces.MODEL_VERSION, embeddings=[sample()] * 3))


def test_durable_faces_share_memory_database_and_delete_cascades(faces):
    p = person(faces)
    assert faces.catalog()['people'][0]['id'] == p['id']
    assert len(faces.catalog()['people'][0]['embeddings']) == 3
    faces.update(p['id'], faces.PersonEdit(name='新名字', relationship='同事', enabled=False))
    assert faces.catalog()['people'] == []
    assert faces.people()[0]['sample_count'] == 3
    faces.delete(p['id'])
    assert faces.people() == []
    from services.digital_person_memory_index import connect
    with connect() as db:
        assert db.execute('SELECT COUNT(*) FROM face_samples').fetchone()[0] == 0
        assert db.execute("SELECT name FROM sqlite_master WHERE name='memories'").fetchone()


def test_validation_and_versions_and_context_settings(faces):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        faces.Enrollment(name='张', relationship='朋友', consent=False, embeddings=[sample()] * 3)
    with pytest.raises(ValidationError):
        faces.Enrollment(name='张', relationship='朋友', consent=True, embeddings=[[float('nan')]*1024]*3)
    p = person(faces)
    with pytest.raises(ValueError):
        person(faces)
    r = faces.context([p['id'], p['id'], 'missing'], 1)
    assert len(r['people']) == 1 and '小张' in r['text'] and '朋友' in r['text']
    assert '正在发言' in r['text']
    before = faces.catalog()['revision']
    faces.save_settings(faces.Settings(enabled=True, include_relationship=False))
    assert faces.catalog()['revision'] > before
    assert faces.context([p['id']], 0) == {'people': [], 'text': ''}
    faces.save_settings(faces.Settings(enabled=False))
    assert faces.context([p['id']], 0)['text'] == ''


def test_face_box_visibility_does_not_change_recognition_context(faces):
    p = person(faces)
    assert faces.get_settings()['settings']['show_boxes'] is True
    faces.save_settings(faces.Settings(enabled=True, show_boxes=False))
    assert faces.catalog()['settings']['show_boxes'] is False
    assert faces.catalog()['settings']['show_names'] is True
    assert faces.context([p['id']], 0)['people'][0]['person_id'] == p['id']
    assert faces.catalog()['settings']['show_relationship'] is False
    faces.save_settings(faces.Settings(enabled=True, show_names=False, show_relationship=True))
    assert faces.catalog()['settings']['show_relationship'] is True
    assert faces.context([p['id']], 0)['people'][0]['relationship'] == '朋友'


def test_person_background_contains_only_known_enabled_people(faces):
    p = person(faces)
    other = faces.create(faces.Enrollment(name='小林', relationship='同事', consent=True, embeddings=[sample()] * 3))
    header = '[Visual Context]\nSource: Camera face recognition\nMatches:'
    assert faces.person_prompt([p['id']]) == f'{header}\n- Name: 小张; Relationship: 朋友'
    assert faces.person_prompt([p['id'], other['id'], p['id'], 'missing']) == (
        f'{header}\n- Name: 小张; Relationship: 朋友\n- Name: 小林; Relationship: 同事'
    )
    assert faces.person_prompt([]) == ''
    assert faces.person_prompt(['missing']) == ''
    faces.save_settings(faces.Settings(enabled=True, include_relationship=False))
    assert faces.person_prompt([p['id']]) == ''
    faces.delete(p['id'])
    assert faces.person_prompt([p['id']]) == ''
    from services.digital_person_memory_index import connect
    with connect() as db:
        assert db.execute("SELECT name FROM sqlite_master WHERE name='face_frames'").fetchone() is None


async def test_api_host_authorization_and_slow_db_canary(faces, monkeypatch):
    from api.digital_person import router
    from services.remote_access import ActorSnapshot, actor_context
    app = FastAPI(); app.include_router(router)
    @app.get('/health')
    async def health(): return {'ok': True}
    entered, release = threading.Event(), threading.Event()
    original = faces.catalog
    def slow():
        entered.set(); assert release.wait(3)
        return original()
    monkeypatch.setattr(faces, 'catalog', slow)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/digital-person/faces/catalog'))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally: release.set()
        assert (await pending).status_code == 200
        response = await client.post('/api/digital-person/faces/people', json={
            'name':'小张','relationship':'朋友','consent':True,'embeddings':[sample()]*3})
        assert response.status_code == 200, response.text
        actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d',
            source='remote_project', project_id='p', access_level='edit')
        with actor_context(actor):
            for method, path, body in [('GET','catalog',None), ('GET','people',None),
                ('POST','people',{}), ('POST','context',{'person_ids':[], 'unknown_count':0})]:
                assert (await client.request(method, '/api/digital-person/faces/'+path,json=body)).status_code == 403


async def test_real_memory_connection_lock_does_not_block_event_loop(faces):
    from api.digital_person import router
    from services.digital_person_memory_index import connect
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health(): return {'ok':True}
    entered,release=threading.Event(),threading.Event()
    def hold_connection():
        with connect():
            entered.set();assert release.wait(4)
    holder=asyncio.create_task(asyncio.to_thread(hold_connection))
    assert await asyncio.to_thread(entered.wait,2)
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/faces/catalog'))
        try:
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
            await asyncio.sleep(.02)
            assert not pending.done()
        finally:release.set()
        assert (await pending).status_code==200
    await holder


def test_sample_crud_and_no_cross_version_or_invalid_vectors(faces):
    from pydantic import ValidationError
    p=person(faces)
    original=faces.revision()['revision']
    faces.add_samples(p['id'],faces.Samples(embeddings=[sample()]))
    rows=faces.samples(p['id']);assert len(rows)==4
    faces.delete_sample(p['id'],rows[0]['id'])
    assert len(faces.samples(p['id']))==3 and faces.revision()['revision']>original
    for value in ([[0.0]*1024],[[True]*1024],[[1.0]*128]):
        with pytest.raises(ValidationError):faces.Samples(embeddings=value)
    with pytest.raises(ValidationError):faces.Samples(embeddings=[sample()],model_version='old')
    for row in faces.samples(p['id']):faces.delete_sample(p['id'],row['id'])
    assert faces.catalog()['people']==[]
    assert faces.context([p['id']],0)['people']==[]
