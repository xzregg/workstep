import json
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime

async def test_memory_token_is_scrubbed_from_journal_agui_bus_and_prompt_but_still_works(runtime,tmp_path):
    from services import memory_query
    from agent_assistants.event_journal import TurnEventJournal
    from agent_assistants.prompt_input import format_prompt_input
    from engines.core.agui import to_agui_events
    from streaming.bus import EventBus
    current,project,_ = runtime
    token = await memory_query.issue_access(current.projects,'local')
    event = {'type':'tool_call','data':{'tool_call_id':'call-1','kind':'execute',
            'title':'workstep --json memory search --token '+token,
            'raw_input':{'memory_token':token,'command':'workstep memory search --token '+token}}}
    journal = TurnEventJournal()
    ref = await journal.astart(tmp_path,'session','message')
    try:
        await journal.arecord(ref,event,force=True)
        raw = (tmp_path/ref.relative_path).read_text()
        assert token not in raw
        assert '[REDACTED_MEMORY_TOKEN]' in raw
        assert token not in json.dumps(to_agui_events(event))
        assert token not in format_prompt_input({'system_prompt':memory_query.instruction(token),'prompt':'hello'})
        bus = EventBus()
        queue=bus.subscribe()
        await bus.publish({'type':'CUSTOM','value':{'command':token}})
        assert token not in json.dumps(await queue.get())
        await bus.close()
        assert event['data']['raw_input']['memory_token'] == token
        assert (await memory_query.search(current.projects,token,include_knowledge=False))['items'] == []
    finally:
        await journal.aclose()


def test_redaction_does_not_need_live_token_registry():
    from services.memory_secrets import redact
    token='wsm_'+'x'*43
    value={'outer':[token,{'shell':'--token '+token}], 'message':'unchanged'}
    cleaned=redact(value)
    assert token not in json.dumps(cleaned)
    assert cleaned['message']=='unchanged'
    assert value['outer'][0]==token
