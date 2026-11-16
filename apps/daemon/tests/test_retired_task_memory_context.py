"""Retired implicit memory prompts must not perform storage work."""
async def test_task_memory_prompt_does_not_resolve_projects_or_touch_storage():
    from services.digital_person_memory import task_context_prompt

    class NoStorage:
        def __getattr__(self, name):
            raise AssertionError(f'retired prompt must not call {name}')

    assert await task_context_prompt(NoStorage(), 'project', 'task', 'question') == ''
