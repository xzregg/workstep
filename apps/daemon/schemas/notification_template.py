"""Shared notification template contract; only named placeholders are supported."""
import re

TEMPLATE_VARIABLES = (
    'notification_title', 'event_name', 'project_name', 'workflow_name',
    'task_title', 'step_line', 'time', 'task_link', 'event', 'step_name',
    'task_url', 'occurred_at',
)
TEMPLATE_VARIABLE = re.compile(r'(?<!\\)\{([^{}\n]*)\}')
MAX_TEMPLATE_LENGTH = 8000
MAX_MARKDOWN_BYTES = 3900
DEFAULT_MARKDOWN_TEMPLATE = '''### {notification_title}

**事件：{event_name}**

项目：{project_name}

流程：{workflow_name}

任务：{task_title}

{step_line}

**时间：{time}**

{task_link}'''


def validate_markdown_template(value: str | None) -> str | None:
    if value is None:
        return None
    if not value.strip():
        raise ValueError('Markdown template cannot be empty, please fill in the content or restore the default template')
    unknown = sorted({match.group(1) for match in TEMPLATE_VARIABLE.finditer(value)} - set(TEMPLATE_VARIABLES))
    if unknown:
        raise ValueError('Unsupported template variable:' + '、'.join(unknown))
    return value
