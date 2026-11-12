import pytest

from services.prototype_source import HtmlSource, SourceConflict


def test_precise_duplicate_selection_and_style_preservation():
    source = '<!doctype html><!--keep--><button class="x">A</button><button class="x" style="color: red">B</button>'
    document = HtmlSource(source)
    nodes = [node for node in document.nodes.values() if node.tag == 'button']
    result = document.edit(nodes[1].id, 'style', {'width': '240px'}, document.version)
    assert '<button class="x">A</button>' in result
    assert 'color: red' in result and 'width: 240px' in result
    assert '<!--keep-->' in result and 'data-ws-node' not in result


def test_text_edit_preserves_nested_markup_and_escapes_input():
    document = HtmlSource('<p>Hello <strong>world</strong>!</p>')
    node = next(node for node in document.nodes.values() if node.tag == 'strong')
    assert document.edit(node.id, 'text', {'text': '<nice>'}, document.version) == '<p>Hello <strong>&lt;nice&gt;</strong>!</p>'
    parent = next(node for node in document.nodes.values() if node.tag == 'p')
    with pytest.raises(ValueError):
        document.edit(parent.id, 'text', {'text': 'oops'}, document.version)


def test_delete_exact_node_and_stale_version():
    document = HtmlSource('<div><span>A</span><span>B</span></div>')
    node = next(node for node in document.nodes.values() if node.tag == 'span')
    assert document.edit(node.id, 'delete', {}, document.version) == '<div><span>B</span></div>'
    with pytest.raises(SourceConflict):
        document.edit(node.id, 'delete', {}, 'old')


def test_preview_markers_never_change_source_and_void_nodes():
    document = HtmlSource('<!doctype html><img src="a.png"><p>Hi</p>')
    assert 'data-ws-node=' in document.preview()
    node = next(node for node in document.nodes.values() if node.tag == 'img')
    assert document.edit(node.id, 'delete', {}, document.version) == '<!doctype html><p>Hi</p>'


def test_unsafe_style_and_document_deletion_rejected():
    document = HtmlSource('<html><body><p>A</p></body></html>')
    node = next(node for node in document.nodes.values() if node.tag == 'p')
    with pytest.raises(ValueError):
        document.edit(node.id, 'style', {'background-color': 'url(https://example.com)'}, document.version)
    with pytest.raises(ValueError):
        document.edit('n1', 'delete', {}, document.version)


def test_style_parser_preserves_data_urls_and_quoted_attribute_text():
    doc = HtmlSource('''<div title='fake style=wrong' style="background: url('data:image/png;base64,AAAA'); color:red">A</div>''')
    result = doc.edit('n1', 'style', {'color': 'blue'}, doc.version)
    assert "title='fake style=wrong'" in result
    assert 'data:image/png;base64,AAAA' in result
    assert 'color: blue' in result


def test_comment_content_cannot_be_destroyed_by_text_edit():
    doc = HtmlSource('<p>A<!--binding--></p>')
    with pytest.raises(ValueError):
        doc.edit('n1', 'text', {'text': 'B'}, doc.version)


def test_inspector_uses_full_text_not_truncated_selection_summary():
    text='word ' * 400
    doc=HtmlSource('<p>'+text+'</p>')
    assert doc.context('n1')['text_value']==text
    assert not HtmlSource('<body>text</body>').context('n1')['text_editable']
