"""Opt-in live-model acceptance with real chat prompt, tools, API and disk config.

Enable with WORKSTEP_RUN_IDENTITY_MODEL_EVAL=1; keep pytest --basetemp under tmp/.
Only the model runner is narrowed to Pydantic Agent + allowlisted tools. No shell,
real user history, live identity mutation, external messages or project work.
"""
import asyncio
import hashlib
import json
import sys
import os
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport

ROOT = Path(__file__).resolve().parents[3] / 'tmp/digital-hub-setup'
DAEMON = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DAEMON))

from services.config import config_store as live_store
from engines.pydantic_ai.engine import PydanticAIEngine

# Resolve the already-configured model before the test's isolated configuration.
# The provider record/credential remains in memory, never in evidence files.
RUN_MODEL = os.environ.get('WORKSTEP_RUN_IDENTITY_MODEL_EVAL') == '1'
pytestmark = pytest.mark.skipif(not RUN_MODEL, reason='explicit real-model identity interview evaluation only')
if RUN_MODEL:
    LIVE_CONFIG = live_store.get_pydantic_ai_engine_config()
    LIVE_RUNTIME = PydanticAIEngine().resolve_provider_runtime(
        provider_id=LIVE_CONFIG.get('provider_id', ''), model=LIVE_CONFIG.get('model', ''))
    LIVE_PROVIDER = live_store.get_provider(LIVE_RUNTIME.provider_id)
from tests.test_chat_session import chat_module, _wait_turn
from tests.test_digital_person_runtime import runtime


@pytest.mark.asyncio
@pytest.mark.timeout(900)
async def test_real_model_natural_interview(runtime, monkeypatch, tmp_path):
    import main
    from pydantic_ai import Agent, UsageLimits
    from pydantic_ai.messages import ModelRequest, SystemPromptPart
    from services import config, digital_person as service
    from services.tool_registry import WorkstepClient, workstep_tools_instruction
    from api.digital_person import router
    from models.chat_session import ChatMessage

    current, project, store = runtime
    ROOT.mkdir(parents=True,exist_ok=True)
    config_directory=tmp_path/'identity-config'
    config_directory.mkdir(exist_ok=True)
    monkeypatch.setattr(config,'CONFIG_DIR',config_directory)
    monkeypatch.setattr(config,'CONFIG_FILE',config_directory/'config.json')
    disk_store = config.ConfigStore()
    monkeypatch.setattr(service, 'config_store', disk_store)
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    monkeypatch.setattr('services.digital_person_statistics.enabled_skills', lambda _: [])
    app = FastAPI()
    app.include_router(router)
    client = WorkstepClient(transport=ASGITransport(app=app))
    model = PydanticAIEngine.build_model(provider=LIVE_PROVIDER, model_name=LIVE_RUNTIME.model,
                                       protocol=LIVE_RUNTIME.protocol)
    evidence = {'model':LIVE_RUNTIME.model, 'protocol':LIVE_RUNTIME.protocol,
                'scope':'synthetic identity, isolated disk configuration, real provider/model and real host API',
                'runner':'real ChatSessionModule prompt/history/DB; restricted Pydantic Agent model runner; native WorkstepClient ASGI transport',
                'turns':[], 'checks':{}, 'limitations':['Not a browser-to-live-daemon/production-engine-harness test',
                'Unrelated user-preference lookup uses an empty synthetic fixture; only identity/info tools call the real API.']}
    histories = {}
    calls = []
    prompts = []

    def flush():
        (ROOT/'interview-model-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))

    async def workstep_call(operation:str, arguments:dict) -> dict:
        """Call an available WorkStep operation with its JSON arguments."""
        if operation == 'workstep_memory_preferences':
            result = {'items':[], 'owner':{'id':'synthetic-owner','name':'合成验收用户'}, 'has_more':False}
        elif operation in {'workstep_get_digital_hub_identity_setup', 'workstep_set_digital_hub_identity', 'workstep_get_digital_hub_info'}:
            result = await client.call(operation,arguments)
        else:
            result = {'ok':False,'error':'This isolated acceptance workspace supports identity setup/info only.'}
        calls.append({'operation':operation,'arguments':arguments,'result':result})
        return result
    workstep_call.__doc__ = workstep_tools_instruction()

    async def read_file(path:str) -> str:
        """Read a bundled workstep-cli SKILL.md or its transport, memory, digital-person reference. No other files are exposed."""
        name = path.replace('\\','/').split('/')[-1]
        if name not in {'SKILL.md','transport.md','memory.md','digital-person.md'}:
            return 'Only the bundled workstep-cli skill and its relevant references are available.'
        relative = name if name == 'SKILL.md' else 'references/'+name
        return await asyncio.to_thread((DAEMON/'data/skills/workstep-cli'/relative).read_text)

    async def invoke(session, turn, callback, engine, model_name, cwd, prompt, session_id, **kwargs):
        instructions = kwargs.get('system_prompt','')
        prompts.append(instructions)
        agent = Agent(model,tools=[workstep_call,read_file],system_prompt=instructions)
        history = histories.get(session.session_id,[])
        result = await asyncio.wait_for(agent.run(prompt,message_history=history,
            model_settings={'temperature':0,'max_tokens':3000},usage_limits=UsageLimits(request_limit=12)),180)
        # Recreate the current system instruction every turn; preserve actual model tool/message history.
        cleaned=[]
        for message in result.all_messages():
            if isinstance(message,ModelRequest):
                message.parts=[part for part in message.parts if not isinstance(part,SystemPromptPart)]
                if not message.parts:continue
            cleaned.append(message)
        histories[session.session_id]=cleaned
        return str(result.output), [], session_id or 'live-identity-'+session.session_id
    monkeypatch.setattr(current.chats,'_invoke_with_idle_watchdog',invoke)

    async def new_main():
        await current.mutate(lambda state:state.update(main_session_id=''))
        return (await current.main_session())['id']

    async def say(sid,label,text):
        before=service.get_profile().model_dump()
        call_start=len(calls)
        accepted=await current.projects.run_db(project.id,lambda _:current.chats.submit_message(
            project.id,sid,text,'acceptance-'+str(len(evidence['turns'])),schedule=False))
        current.chats.start_queued_turn(accepted.turn_id)
        status=await _wait_turn(current.chats,accepted.turn_id,timeout=200)
        rows=await current.projects.run_db(project.id,lambda _:[{'role':r.role,'content':r.content,'status':r.status}
            for r in ChatMessage.select().where(ChatMessage.session==sid).order_by(ChatMessage.created_at,ChatMessage.id)])
        reply=next((r['content'] for r in reversed(rows) if r['role']=='assistant'),'')
        after=service.get_profile().model_dump()
        evidence['turns'].append({'label':label,'user':text,'assistant':reply,'turn_status':status,
            'profile_before':before,'profile_after':after,'setup_after':service.identity_setup_status(),
            'tools':calls[call_start:],'system_prompt':prompts[-1] if prompts else '',
            'config_file':str(config.CONFIG_FILE),
            'config_sha256':hashlib.sha256(config.CONFIG_FILE.read_bytes()).hexdigest()})
        flush()
        print(json.dumps({'turn':label,'status':status,'setup':service.identity_setup_status().get('step',service.identity_setup_status()['status'])},ensure_ascii=False),flush=True)
        assert status=='completed',label
        return reply

    def check(label,condition):
        evidence['checks'][label]=bool(condition)
        flush()
        assert condition,label

    def menu_options(reply):
        options={}
        for line in reply.replace('；','\n').replace(';','\n').splitlines():
            match=re.match(r'^\s*(?:\*\*)?([1-4A-D])[.、)）:：]\s*',line,re.I)
            if match:
                key=match.group(1).upper()
                assert key not in options, 'Menu IDs must not be reused for combinations'
                options[key]=line
        return options

    try:
        disk_store.set('digital_person',{})
        service.save_profile(service.DigitalPersonProfile(enabled=True))
        sid=await new_main()
        initial=service.get_profile().name
        reply=await say(sid,'unknown-name-and-suggestion','名字还没想好，由你建议吧。')
        check('suggestion_not_assumed_accepted',service.identity_setup_status()['step']=='name' and not service.identity_setup_status()['answers'] and bool(reply.strip()))
        reply=await say(sid,'several-fields-one-reply','就叫澄知。我喜欢温和但严谨的表达，主要做项目跟进和资料检索。')
        state=service.identity_setup_status()
        check('extract_multiple_fields_without_reasking',state['step']=='role' and all(k in state['answers'] for k in ('name','personality','duties')) and '温和' in state['answers']['personality'] and '严谨' in state['answers']['personality'] and '项目' in state['answers']['duties'] and '检索' in state['answers']['duties'])
        check('still_only_draft',service.get_profile().name==initial)
        reply=await say(sid,'vague-role-menu','就日常帮帮我吧，具体定位不知道、还没想好，给几个选择？')
        check('vague_not_saved_and_role_choices',service.identity_setup_status()['step']=='role' and 'role' not in service.identity_setup_status()['answers'] and 2<=len(menu_options(reply))<=4 and any(word in reply for word in ('助理','伙伴','秘书','顾问')))
        options=menu_options(reply)
        second_id,second_choice=list(options.items())[1]
        reply=await say(sid,'numbered-role-selection',f'选{second_id}。')
        check('menu_selection_fills_only_missing_field',service.identity_setup_status()['step']=='confirm' and service.identity_setup_status()['summary']['role'] in second_choice)
        reply=await say(sid,'optional-context-privacy','为了了解我还需要什么信息？我只想谈工作安排，其他个人情况不想透露。')
        check('optional_context_one_question',(reply.count('？')+reply.count('?')<=1 or (reply.count('？')+reply.count('?')<=2 and '还是' in reply.split('\n')[-1])) and any(word in reply for word in ('可选','不需要','不用','无需','不必')))
        check('no_unstated_personal_facts',service.identity_setup_status()['step']=='confirm' and service.get_profile().name==initial and all(word not in str(service.identity_setup_status()['answers']) for word in ('财务','健康','股权','收入','疾病')))
        reply=await say(sid,'confirm-first-interview','确认，按刚才这份汇总保存。')
        check('confirmation_keeps_one_core_question',reply.count('？')+reply.count('?')<=1)
        check('first_interview_committed',service.get_profile().name=='澄知' and service.identity_setup_status()['status']=='completed')
        first_role=service.get_profile().role
        reply=await say(sid,'reset-with-known-name-role','我要重新设定身份。这次性格和职责要重新选择，不要自动沿用这两项；名字沿用澄知，角色选私人助理。我在小公司做事，个人信息不想透露。')
        check('reset_extracts_existing_answers',service.identity_setup_status()['step']=='personality' and '私人助理' in service.identity_setup_status()['answers']['role'])
        reply=await say(sid,'unknown-tone-menu','性格和语气没想好，给我容易理解的选项，可以多选吗？')
        check('personality_multiselect_menu',service.identity_setup_status()['step']=='personality' and all(word in reply for word in ('温和','干练','活泼','严谨')) and ('多选' in reply or '组合' in reply))
        await say(sid,'select-several-traits','温和、干练、严谨都要，回复先给结论。')
        state=service.identity_setup_status()
        check('all_traits_and_preference_retained',state['step']=='duties' and all(word in state['answers']['personality'] for word in ('温和','干练','严谨','结论')))
        reply=await say(sid,'uncertain-duties-menu','职责还没想好，请列原始四个选项让我多选；我也想自由补充。')
        check('duties_multiselect_menu',service.identity_setup_status()['step']=='duties' and all(word in reply for word in ('提醒','项目','检索','文档')))
        options=menu_options(reply)
        check('single_unambiguous_duties_menu',2<=len(options)<=4 and not any(digit in reply for digit in '①②③④'))
        selected=[]
        for term in ('项目','检索'):
            selected.append(next(key for key,line in options.items() if term in line))
        await say(sid,'multiple-tasks-and-free-addition',f'选{selected[0]}和{selected[1]}，再加会议纪要。以上所有任务都不要自动执行，需我明确交代。')
        state=service.identity_setup_status()
        check('tasks_free_addition_and_boundary_retained',state['step']=='confirm' and all(word in state['answers']['duties'] for word in ('项目','检索','会议纪要')) and any(word in state['answers']['duties'] for word in ('不自动','不要自动','确认','明确','授权','指令','按需')))
        duties=state['answers']['duties']
        await say(sid,'go-back-correct-role','回到角色，把定位改成项目秘书，其他不变，先别保存。')
        state=service.identity_setup_status()
        check('backtrack_preserves_other_fields',state['step']=='confirm' and '项目秘书' in state['answers']['role'] and state['answers']['duties']==duties and service.get_profile().role==first_role)
        await say(sid,'skip-previous-answer','性格这项还是跳过，用目前正式配置的就好。')
        state=service.identity_setup_status()
        check('optional_skip_reverts_to_effective_value',state['answers']['personality']==service.get_profile().personality and state['answers']['duties']==duties)
        await say(sid,'exit-interview','不想继续了，退出引导，别再追问。')
        state=service.identity_setup_status()
        check('exit_persists_paused',state['paused'] and service.get_profile().role==first_role)
        disk_store.invalidate()
        histories.clear()
        current.chats._sessions.clear()
        reply=await say(sid,'ordinary-chat-after-reload','你好，写一句简短的春日问候。')
        check('exit_stays_paused_across_reload',service.identity_setup_status()==state and not any(word in reply for word in ('名字','角色','性格','职责','设定')))
        await say(sid,'explicit-resume','继续刚才的身份设定，先给我汇总，不要保存。')
        state=service.identity_setup_status()
        check('resume_requires_explicit_request',not state['paused'] and state['step']=='confirm' and service.get_profile().role==first_role)
        await say(sid,'final-confirm','确认保存。')
        check('final_confirm_saves_reviewed_identity',service.identity_setup_status()['status']=='completed' and service.get_profile().role=='项目秘书' and service.get_profile().duties==duties)
        service.save_profile(service.get_profile().model_copy(update={'name':'澄知助手'}))
        reply=await say(sid,'later-settings-name-change','你现在叫什么？只回答当前完整名字。')
        check('later_settings_override_old_name_in_history','澄知助手' in reply)
        evidence['result']='passed'
        flush()
    except BaseException as exc:
        evidence['result']='failed'
        evidence['failure_type']=type(exc).__name__
        flush()
        raise
