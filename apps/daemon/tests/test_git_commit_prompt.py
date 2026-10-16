"""Step prompts guide Git attribution without changing engine or Git config."""

from datetime import timedelta

import pytest

from models import Task, WorkflowRun, init_db
from models.fields import utc_now
from services.messages import attributed_actor_display_name, create_task_message
from services.pipeline import Step
from services.prompt import (
    SYSTEM_PROMPT, assemble_followup_prompt, assemble_prompt, assemble_retry_prompt,
)


@pytest.fixture
def task_context(tmp_path):
    db = init_db(str(tmp_path / 'test.db'))
    now = utc_now()
    task = Task.create(id='task', title='Code', cwd=str(tmp_path), creator_id='creator',
                       creator_name='Creator', creator_username='creator',
                       created_at=now, updated_at=now)
    run = WorkflowRun.create(id='run', task=task, workflow_schema_version=1,
                             initiated_by_user_id='alice', initiated_by_username='alice-login',
                             initiated_by_name='Alice Display', started_at=now)
    task.active_workflow_run_id = run.id
    task.save()
    yield task, Step(key='code', label='Code'), tmp_path / 'artifacts', run
    db.close()


def test_commit_guidance_is_shared_and_does_not_request_automatic_commits():
    assert 'Only commit when' in SYSTEM_PROMPT
    assert 'git -c user.name=' in SYSTEM_PROMPT
    assert 'email' in SYSTEM_PROMPT
    assert 'Do not change global' in SYSTEM_PROMPT
    assert 'most recent delivered' in SYSTEM_PROMPT


@pytest.mark.parametrize('kind', ['initial', 'followup', 'retry'])
def test_every_execution_prompt_carries_current_person(task_context, kind):
    task, step, artifacts, _ = task_context
    name = "Alice O'Neil"
    if kind == 'initial':
        prompt = assemble_prompt(task, step, artifacts, trigger_name=name, separate_instructions=True)
    elif kind == 'followup':
        prompt = assemble_followup_prompt(task, step, artifacts, 'continue', trigger_name=name)
    else:
        prompt = assemble_retry_prompt(task, step, artifacts, {}, trigger_name=name)
    assert f'## Triggered by\n{name}' in prompt


def test_saved_run_identity_beats_creator_and_old_messages(task_context):
    task, step, _, run = task_context
    create_task_message(task=task, channel='execution', role='user', step_key=step.key,
                        author_id='old', author_name='Old User', author_username='old',
                        snapshot_current_actor=False, position=0,
                        created_at=run.started_at - timedelta(minutes=1))
    assert attributed_actor_display_name(task, channel='execution', step_key=step.key) == 'Alice Display'


@pytest.mark.parametrize('name', ['Local User', 'Gateway Display', 'Share visitor'])
def test_delivered_user_identity_supplies_display_name(task_context, name):
    task, step, _, run = task_context
    create_task_message(task=task, channel='execution', role='user', step_key=step.key,
                        author_id='bob', author_name=name, author_username='bob-login',
                        snapshot_current_actor=False, position=0,
                        created_at=run.started_at + timedelta(seconds=1))
    assert attributed_actor_display_name(task, channel='execution', step_key=step.key) == name
