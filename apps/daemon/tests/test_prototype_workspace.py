from pathlib import Path
import pytest
from services.prototype_workspace import PrototypeWorkspace
from services.prototype_source import SourceConflict


def setup_workspace(tmp_path):
    root = tmp_path / 'project'
    root.mkdir()
    (root / 'index.html').write_text('<button>A</button>')
    (root / 'detail.html').write_text('<p>B</p>')
    (root / 'common.css').write_text('button {color:red}')
    return root, PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')


def test_one_workspace_and_stable_documents(tmp_path):
    root, work = setup_workspace(tmp_path)
    second = PrototypeWorkspace.open(root, root / '.workstep', root / 'detail.html')
    assert second.id == work.id
    assert len(work.state()['documents']) == 2
    assert not (work.directory / 'workspace/.workstep').exists()


def test_edit_publish_undo_and_conflict(tmp_path):
    root, work = setup_workspace(tmp_path)
    doc = work.document('index.html')
    work.edit('index.html', 'n1', 'text', {'text': 'new'}, doc.version)
    assert (root / 'index.html').read_text() == '<button>new</button>'
    work.undo()
    assert (root / 'index.html').read_text() == '<button>A</button>'
    work.begin('turn')
    (work.directory / 'workspace/index.html').write_text('<button>model</button>')
    (root / 'index.html').write_text('<button>external</button>')
    with pytest.raises(SourceConflict):
        work.publish()
    assert (root / 'index.html').read_text() == '<button>external</button>'


def test_interrupted_copy_is_preserved_and_not_published(tmp_path):
    root, work = setup_workspace(tmp_path)
    work.begin('turn')
    (work.directory / 'workspace/index.html').write_text('partial')
    reopened = PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')
    assert reopened.state()['status'] == 'running'
    assert (root / 'index.html').read_text() == '<button>A</button>'
    work.discard()
    assert work.document('index.html').source == '<button>A</button>'


def test_boundary_and_symlink(tmp_path):
    root, work = setup_workspace(tmp_path)
    with pytest.raises(ValueError):
        work.document('../outside.html')
    target = work.directory / 'workspace/index.html'
    target.unlink()
    target.symlink_to(root / 'index.html')
    with pytest.raises(ValueError):
        work.document('index.html')


def test_restart_recovers_running_copy(tmp_path, monkeypatch):
    import services.prototype_workspace as module
    root, work = setup_workspace(tmp_path)
    work.begin('turn')
    (work.directory / 'workspace/index.html').write_text('partial')
    monkeypatch.setattr(module, 'PROCESS_ID', 'next-daemon')
    assert work.state()['status'] == 'interrupted'
    assert (work.directory / 'workspace/index.html').read_text() == 'partial'


def test_repeated_undo_walks_back_history(tmp_path):
    root, work = setup_workspace(tmp_path)
    for text in ['B', 'C']:
        work.edit('index.html', 'n1', 'text', {'text': text}, work.document('index.html').version)
    work.undo()
    work.undo()
    assert (root / 'index.html').read_text() == '<button>A</button>'


def test_unregistered_files_are_never_silently_lost(tmp_path):
    root, work = setup_workspace(tmp_path)
    work.begin('turn')
    (work.directory / 'workspace/new.html').write_text('<p>New</p>')
    with pytest.raises(SourceConflict):
        work.publish()
    assert work.state()['status'] == 'conflict'
    assert not (root / 'new.html').exists()
    work.discard()
    assert not (work.directory / 'workspace/new.html').exists()


def test_cleanup_keeps_current_copy_and_clears_history(tmp_path):
    root, work = setup_workspace(tmp_path)
    work.edit('index.html','n1','text',{'text':'B'},work.document('index.html').version)
    work.clean_history()
    assert work.state()['history'] == []
    assert len(list((work.directory / 'history').iterdir())) == len(set(work.load()['files'].values()))


def test_reopen_discovers_new_sibling_html_without_changing_existing_identity(tmp_path):
    root, work = setup_workspace(tmp_path)
    before = work.load()['documents']['index.html']
    (root / 'new.html').write_text('<p>New</p>')
    reopened = PrototypeWorkspace.open(root, root / '.workstep', root / 'new.html')
    assert reopened.id == work.id
    assert reopened.load()['documents']['index.html'] == before
    assert 'new.html' in reopened.load()['documents']


def test_engine_metadata_is_not_a_publishable_resource(tmp_path):
    root, work = setup_workspace(tmp_path)
    work.begin('turn')
    metadata = work.directory / 'workspace/.claude'
    metadata.mkdir()
    (metadata / 'settings.json').write_text('{}')
    (work.directory / 'workspace/index.html').write_text('<p>Changed</p>')
    work.publish()
    assert (root / 'index.html').read_text() == '<p>Changed</p>'
    assert not (root / '.claude').exists()


def test_failed_initial_copy_leaves_no_orphan_workspaces(tmp_path, monkeypatch):
    import services.prototype_workspace as module
    root=tmp_path / 'project'
    root.mkdir()
    (root / 'index.html').write_text('<p>Hello</p>')
    monkeypatch.setattr(module,'MAX_TOTAL',1)
    with pytest.raises(ValueError):
        PrototypeWorkspace.open(root,root / '.workstep',root / 'index.html')
    assert not list((root / '.workstep/prototype-editor').glob('*'))


def test_source_edit_preserves_crlf(tmp_path):
    root, work = setup_workspace(tmp_path)
    (root / 'index.html').write_bytes(b'<div>\r\n<button>A</button>\r\n</div>')
    work.refresh_sources()
    doc=work.document('index.html')
    work.edit('index.html','n2','text',{'text':'B'},doc.version)
    assert (root / 'index.html').read_bytes() == b'<div>\r\n<button>B</button>\r\n</div>'


def test_partial_multi_file_publish_resumes_from_journal(tmp_path, monkeypatch):
    import services.prototype_workspace as module
    root, work = setup_workspace(tmp_path)
    (root / 'index.html').write_text('<button>A</button><link href="common.css">')
    work.refresh_sources()
    work.begin('multiple files')
    (work.directory / 'workspace/index.html').write_text('<p>Changed</p>')
    (work.directory / 'workspace/common.css').write_text('p {color:blue}')
    original_write=module.atomic_write
    def interrupted(path, content):
        if path == root / 'common.css':
            raise OSError('simulated disk interruption')
        original_write(path,content)
    monkeypatch.setattr(module,'atomic_write',interrupted)
    with pytest.raises(SourceConflict):
        work.publish()
    assert work.state()['status'] == 'publishing'
    assert work.state()['pending']
    monkeypatch.setattr(module,'atomic_write',original_write)
    reopened=PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')
    reopened.publish()
    assert reopened.state()['status']=='idle'
    assert (root / 'index.html').read_text()=='<p>Changed</p>'
    assert (root / 'common.css').read_text()=='p {color:blue}'
    assert len(reopened.state()['history'])==1


@pytest.mark.parametrize('external_data', [False, True])
def test_upload_prototype_is_not_claimed_by_parent_workspace(tmp_path, external_data):
    root, parent = setup_workspace(tmp_path)
    data = tmp_path / 'external-data' if external_data else root / '.workstep'
    entry = data / 'uploads/digital-person-prototype/human-brain.html'
    entry.parent.mkdir(parents=True)
    entry.write_text('<h1>Brain</h1>')
    work = PrototypeWorkspace.open(root, data, entry)
    assert work.id != parent.id
    assert work.document('human-brain.html').source == '<h1>Brain</h1>'
    assert work.original() == entry.parent
    assert PrototypeWorkspace.open(root, data, entry).id == work.id
    if not external_data:
        assert PrototypeWorkspace.open(root, data, root / 'index.html').id == parent.id


def test_open_new_sibling_during_turn_reports_conflict(tmp_path):
    root, work = setup_workspace(tmp_path)
    work.begin('editing')
    (root / 'new.html').write_text('<p>New</p>')
    with pytest.raises(SourceConflict):
        PrototypeWorkspace.open(root, root / '.workstep', root / 'new.html')
    assert work.state()['status'] == 'running'


def test_copy_only_sibling_html_and_transitive_local_resources(tmp_path, monkeypatch):
    import services.prototype_workspace as module
    root = tmp_path / 'project'
    root.mkdir()
    (root / 'index.html').write_text('<link href="assets/main.css"><script src="assets/app.js"></script><a href="pages/detail.html">Detail</a>')
    (root / 'sibling.html').write_text('<img src="assets/second.svg">')
    for name in ['assets', 'pages', 'unrelated']:
        (root / name).mkdir()
    (root / 'assets/main.css').write_text('@import "colors.css"; p{background:url("bg.svg?v=1")}')
    (root / 'assets/colors.css').write_text('p{color:blue}')
    (root / 'assets/bg.svg').write_text('<svg/>')
    (root / 'assets/second.svg').write_text('<svg/>')
    (root / 'assets/app.js').write_text('import "./helper.js"; fetch("./data.json")')
    (root / 'assets/helper.js').write_text('export const x=1')
    (root / 'data.json').write_text('{}')
    (root / 'pages/detail.html').write_text('<img src="../assets/bg.svg">')
    (root / 'unrelated/huge.json').write_text('x' * 2000)
    (root / 'unused.png').write_bytes(b'x' * 2000)
    monkeypatch.setattr(module, 'MAX_FILE', 1000)
    monkeypatch.setattr(module, 'MAX_TOTAL', 1500)
    work = PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')
    assert set(work.state()['files']) == {'index.html','sibling.html','pages/detail.html',
        'assets/main.css','assets/colors.css','assets/bg.svg','assets/second.svg',
        'assets/app.js','assets/helper.js','data.json'}
    assert not (work.directory / 'workspace/unrelated').exists()
    first_id = work.load()['documents']['index.html']
    work.edit('index.html', 'n3', 'style', {'color':'red'}, work.document('index.html').version)
    assert work.state()['status'] == 'idle'
    assert work.load()['documents']['index.html'] == first_id


def test_open_unlinked_nested_page_keeps_it_on_future_refreshes(tmp_path):
    root, work = setup_workspace(tmp_path)
    page = root / 'pages/unlinked.html'
    page.parent.mkdir()
    page.write_text('<p>Nested</p>')
    reopened = PrototypeWorkspace.open(root, root / '.workstep', page)
    assert reopened.id == work.id
    document_id = reopened.load()['documents']['pages/unlinked.html']
    work.begin('refresh')
    work.publish()
    assert work.document('pages/unlinked.html').source == '<p>Nested</p>'
    assert work.load()['documents']['pages/unlinked.html'] == document_id


def test_referenced_resource_limit_identifies_the_file(tmp_path, monkeypatch):
    import services.prototype_workspace as module
    root = tmp_path / 'project'
    root.mkdir()
    (root / 'index.html').write_text('<img src="large.png">')
    (root / 'large.png').write_bytes(b'x' * 101)
    monkeypatch.setattr(module, 'MAX_FILE', 100)
    with pytest.raises(ValueError, match='large.png'):
        PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')


def test_referenced_symlink_does_not_escape_copy(tmp_path):
    root, _ = setup_workspace(tmp_path)
    outside = tmp_path / 'secret.json'
    outside.write_text('{}')
    (root / 'linked.json').symlink_to(outside)
    (root / 'index.html').write_text('<script src="linked.json"></script>')
    with pytest.raises(ValueError, match='符号链接'):
        PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')


def test_resource_selection_keeps_legacy_document_identity(tmp_path):
    root, work = setup_workspace(tmp_path)
    page = root / 'pages/detail.html'
    page.parent.mkdir()
    page.write_text('<p>Legacy</p>')
    work = PrototypeWorkspace.open(root, root / '.workstep', page)
    data = work.load()
    legacy_id = data['documents']['pages/detail.html']
    data.pop('entries')
    work.save(data)
    work.begin('legacy refresh')
    work.publish()
    assert work.document('pages/detail.html').source == '<p>Legacy</p>'
    assert work.load()['documents']['pages/detail.html'] == legacy_id


def test_selected_resources_still_enforce_total_budget(tmp_path, monkeypatch):
    import services.prototype_workspace as module
    root = tmp_path / 'project'
    root.mkdir()
    (root / 'index.html').write_text('<img src="one.png"><img src="two.png">')
    (root / 'one.png').write_bytes(b'a' * 100)
    (root / 'two.png').write_bytes(b'b' * 100)
    monkeypatch.setattr(module, 'MAX_TOTAL', 150)
    with pytest.raises(ValueError, match='引用资源总量'):
        PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')
    assert not list((root / '.workstep/prototype-editor').glob('*'))


@pytest.mark.parametrize('legacy', [False, True])
def test_removed_historical_page_directory_does_not_block_opening_new_page(tmp_path, legacy):
    root, work = setup_workspace(tmp_path)
    old = root / 'old/page.html'
    old.parent.mkdir()
    old.write_text('<p>Old</p>')
    work = PrototypeWorkspace.open(root, root / '.workstep', old)
    existing_id = work.load()['documents']['index.html']
    if legacy:
        data = work.load()
        data.pop('entries')
        work.save(data)
    old.unlink()
    old.parent.rmdir()
    new = root / 'new/index.html'
    new.parent.mkdir()
    new.write_text('<p>New</p>')
    reopened = PrototypeWorkspace.open(root, root / '.workstep', new)
    assert reopened.id == work.id
    assert reopened.document('new/index.html').source == '<p>New</p>'
    assert reopened.load()['documents']['index.html'] == existing_id
    assert 'old/page.html' not in reopened.load()['entries']
    assert 'old/page.html' not in reopened.load()['documents']



def test_element_move_publishes_only_selected_translate_and_can_undo(tmp_path):
    root = tmp_path / 'project'
    root.mkdir()
    source = '<button style="color:red;transform:rotate(5deg)">One</button><button>Two</button>'
    (root / 'index.html').write_text(source)
    work = PrototypeWorkspace.open(root, root / '.workstep', root / 'index.html')
    work.edit('index.html','n1','style',{'translate':'120px -20px'},work.document('index.html').version)
    saved = (root / 'index.html').read_text()
    assert 'translate:120px -20px' in saved.replace(': ',':')
    assert 'transform:rotate(5deg)' in saved
    assert saved.endswith('<button>Two</button>')
    work.undo()
    assert (root / 'index.html').read_text() == source



def test_history_diff_exposes_file_patches_without_joining_unterminated_lines(tmp_path):
    root, work = setup_workspace(tmp_path)
    work.edit('index.html','n1','text',{'text':'Changed'},work.document('index.html').version)
    revision = work.state()['history'][-1]
    assert isinstance(revision['time'],(int,float))
    result = work.diff(revision['id'])
    assert result['files'][0]['path'] == 'index.html'
    patch = result['files'][0]['patch']
    assert '-<button>A</button>\n' in patch
    assert '+<button>Changed</button>\n' in patch
    assert '\\ No newline at end of file' in patch
    assert result['diff'] == patch
