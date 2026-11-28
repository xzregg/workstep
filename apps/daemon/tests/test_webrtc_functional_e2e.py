"""Business and media regression through the bootstrap-only direct workspace."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from tests import test_webrtc_browser_e2e as browser_suite


@pytest.mark.timeout(240)
@pytest.mark.asyncio
async def test_direct_workspace_functional_regression(tmp_path, monkeypatch, caplog):
    previous=browser_suite._build_node_runner
    fixtures=Path(__file__).parent/'fixtures'/'webrtc'

    def runner():
        import main
        from engines.core.events import InternalEvent
        import agent_assistants.base as base
        import agent_assistants.chat_session as sessions
        import agent_assistants.chat_roles as roles

        class Engine:
            capabilities=SimpleNamespace(supports_coordinator=True,supports_live_step_message=True)
            supports_resume=False
            supports_message_history=False
            @staticmethod
            def supports_provider(_provider):
                return True

        async def invoke(engine_id,model,cwd,prompt,session_id,on_event=None,message_history=None,**kwargs):
            events=[]
            for text in ('直连流式第一段。','直连流式第二段。'):
                event=InternalEvent('agent_message_chunk',{'content':{'text':text}})
                events.append(event.to_dict())
                if on_event:
                    await on_event(event)
                await asyncio.sleep(.15)
            if 'rtc-stop-test' in str(prompt):
                await asyncio.sleep(30)
            return '直连流式第一段。直连流式第二段。',events,None

        for module in (base,sessions,roles):
            monkeypatch.setattr(module,'create_engine',lambda _name:Engine())
        monkeypatch.setattr(base,'invoke_engine',invoke)
        monkeypatch.setattr(main.chat_session_module,'_invoke',invoke)
        source=previous()
        marker='    if (screenshotDir) {\n      // Also capture remote read-only'
        assert marker in source
        extra=(fixtures/'functional.cjs').read_text()
        config={'video':str(fixtures/'sample.webm'),
                'mp3':str(fixtures/'sample.mp3'),'m4a':str(fixtures/'sample.m4a'),
                'font':str(browser_suite.REPO_ROOT/'apps/web/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2'),
                'apk':str(browser_suite.REPO_ROOT/'apps/android/app/build/outputs/apk/debug/app-debug.apk')}
        injection=extra+'\n    await runFunctional(page,cfg,screenshotDir,'+json.dumps(config)+');\n'
        return source.replace(marker,injection+marker)

    monkeypatch.setattr(browser_suite,'_build_node_runner',runner)
    await browser_suite.test_chromium_direct_webrtc_p2p_e2e(tmp_path,monkeypatch,caplog,done_timeout=180)
