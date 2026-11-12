from copy import deepcopy

import pytest

from services.task_workflow import build_overrides, canonical_workflow, merge_workflow, WorkflowConflict
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError
from services.prompt import _format_output_specs, _format_retry_output_paths


def flow(template='# Summary'):
    output = {'name': 'report', 'type': 'md', 'template': template}
    return {'nodes': [{'id': 1, 'type': 'build', 'inputs': [
        {'name': 'request', 'type': 'md', 'outputs': [deepcopy(output)]}],
        'outputs': [output]}], 'connections': []}


def set_template(value, template):
    node = value['nodes'][0]
    node['outputs'][0]['template'] = template
    node['inputs'][0]['outputs'][0]['template'] = template


@pytest.mark.parametrize('template', ['# Task only\n[One sentence]', ''])
def test_task_template_override_rebases_without_touching_ports(template):
    source = flow()
    edited = canonical_workflow(source)
    set_template(edited, template)
    delta = build_overrides(source, edited)
    assert source['nodes'][0]['outputs'][0]['template'] == '# Summary'
    set_template(source, '# Updated source')
    result = merge_workflow(source, delta)
    assert result['nodes'][0]['outputs'][0]['template'] == template
    assert result['nodes'][0]['inputs'][0]['outputs'][0]['template'] == template
    assert build_overrides(source, canonical_workflow(source)) is None
    source['nodes'][0]['outputs'][0]['name'] = 'renamed'
    with pytest.raises(WorkflowConflict):
        merge_workflow(source, delta)


@pytest.mark.parametrize('bad', [42, {}, ['text'], None])
def test_template_must_be_text(bad):
    with pytest.raises(WorkflowValidationError):
        WorkflowDefinition.load(flow(bad)).compile()


@pytest.mark.parametrize('formatter', [_format_output_specs, _format_retry_output_paths])
def test_template_injection_is_short_and_preserves_markdown(formatter):
    body = '# Summary\n[At most 3 items]\n```json\n{}\n```'
    result = formatter([{'name': 'report', 'type': 'md', 'template': body}], '/artifacts')
    assert 'Please use the following template for artifact "report":\n<artifact_template>\n' + body + '\n</artifact_template>' in result
    assert result.count(body) == 1
    assert 'Please use the following template' not in formatter([{'name': 'report', 'type': 'md', 'template': '  '}], '/artifacts')


def test_resumed_session_explicitly_drops_cleared_template():
    assert 'No template is required for artifact "report".' in _format_retry_output_paths(
        [{'name': 'report', 'type': 'md', 'template': ''}], '/artifacts')


@pytest.mark.parametrize('formatter', [_format_output_specs, _format_retry_output_paths])
def test_missing_template_has_no_template_instruction_or_tags(formatter):
    result = formatter([{'name': 'report', 'type': 'md'}], '/artifacts')
    assert 'template' not in result
