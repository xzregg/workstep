"""Task channel outcomes follow persisted message completion, not engine errors."""
import asyncio
from types import SimpleNamespace

import pytest
from services.channels.base import IncomingMessage
from tests.test_channel_bots import bots


@pytest.mark.parametrize('status,expected', [('stopped','已停止。'),('cancelled','已停止。'),('succeeded','最终结果'),('failed','处理失败，请稍后重试。')])
async def test_task_reply_waits_for_terminal_message_after_engine_error(bots,status,expected):
    manager,project,_,_,_,adapters=bots
    bot=await manager.create_bot({'platform':'wecom','name':'BOT','app_id':'bot','secret':'secret','enabled':True,
        'default_target_type':'task','default_project_id':project.id,'default_task_id':'task-1'})
    async def submit(*args,**kwargs):
        async def produce():
            scope={'project_id':project.id,'task_id':'task-1','channel':'coordinator','messageId':'reply'}
            await manager._event_bus.publish({**scope,'type':'RUN_ERROR','status':'failed','error':'engine exited'})
            await manager._event_bus.publish({**scope,'type':'TEXT_MESSAGE_END','status':status,'content':'最终结果','error':'real failure' if status=='failed' else ''})
        asyncio.create_task(produce())
        return SimpleNamespace(assistant_message_id='reply',turn_id='turn')
    manager._coordinator.submit_message=submit
    await asyncio.wait_for(manager.handle_message(IncomingMessage(bot['id'],'incoming','single','user','user','继续')),2)
    assert adapters[bot['id']].sent==[('user',expected)]
