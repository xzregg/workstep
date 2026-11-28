from services.prompt_sections import prompt_context, prompt_section
from tests.prompt_xml import read_context
import json
import pytest


def test_prompt_section_keeps_markdown_and_boundary_lines():
    content = '## Reply rules\n- Keep `<example>` unchanged.\n'
    assert prompt_section('project_memory', content) == (
        '<project_memory>\n' + content + '</project_memory>\n'
    )
    assert prompt_section('project_memory', '') == '<project_memory>\n</project_memory>\n'


def test_prompt_context_wraps_original_json_in_one_named_section():
    context = {'task': {'title': '## Goal\nShip'}, 'steps': [
        {'running': False, 'attempt': 2, 'error': None},
    ], 'empty': [], 'memory': ''}
    prompt = prompt_context(context, description='Current task snapshot as JSON.')
    assert prompt == (
        '<context>\nCurrent task snapshot as JSON.\n\n'
        + json.dumps(context, ensure_ascii=False, indent=2)
        + '\n</context>\n'
    )
    assert read_context(prompt) == context
    assert '<task>' not in prompt
    assert '<item>' not in prompt


@pytest.mark.parametrize('content', [
    '123', 'null', 'true', '[]', '{}',
    '<div>\n<p>Keep the original HTML.</p>\n</div>',
    'XML example:\n<task>\n## User heading\nExample body\n</task>',
    'Keep trailing blank lines.\n\n\n',
])
def test_json_context_preserves_user_strings_and_types(content):
    context = {'project_memory': content, 'current_request': 'Continue'}
    prompt = prompt_context(context)
    assert read_context(prompt) == context
    assert prompt.startswith('<context>\nJSON context for the current request.\n\n{')
    assert prompt.endswith('}\n</context>\n')
