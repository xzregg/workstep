"""Deterministic delegation completion delivery; never invokes an LLM."""
import asyncio
import uuid
from models.chat_session import ChatMessage
from models.fields import utc_now
from services.chat_read_state import TERMINAL, is_read


def quiet(profile):
    hour=utc_now().astimezone().hour
    start,end=profile.quiet_start,profile.quiet_end
    return start!=end and (start<=hour<end if start<end else hour>=start or hour<end)


class DelegationFollower:
    def __init__(self,runtime):
        self.runtime=runtime
        self.lock=asyncio.Lock()

    async def poll(self,profile):
        if not profile.enabled or self.lock.locked():
            return
        async with self.lock:
            state=await self.runtime.state()
            for item in state.get('delegations',[]):
                if item.get('notified') or item.get('followup_state'):
                    continue
                try:
                    await self._follow(item,profile)
                except Exception:
                    import logging
                    logging.getLogger(__name__).exception('Delegation follow-up failed: %s',item.get('id'))

    async def _follow(self,item,profile):
        runtime=self.runtime
        if await runtime.delegation_management._execution_archived(item):
            return
        def read(_):
            message=ChatMessage.get_or_none(ChatMessage.id==item['message_id'],ChatMessage.session==item['session_id'])
            if message is None:
                return {'status':'missing','content':'执行消息已不存在。','read':False}
            return {'status':message.status,'content':message.content[:2000] if message.status in TERMINAL else '',
                    'read':is_read(item['project_id'],message) if message.status in TERMINAL else False}
        try:
            result=await runtime.projects.run_db(item['project_id'],read)
        except (ValueError,LookupError):
            result={'status':'missing','content':'执行项目已不可用。','read':False}
        status=result['status']
        if status == 'running' and item.get('continuation_of') and runtime.chats.is_turn_queued(item['turn_id']):
            status = 'queued'
        terminal=status in TERMINAL or status=='missing'
        run_id=str(uuid.uuid5(uuid.NAMESPACE_URL,'workstep-delegation:'+item.get('execution_id',item['id'])))
        def update(state):
            current=next((d for d in state['delegations'] if d['id']==item['id']),None)
            if current is None or current.get('notified'):
                return False
            current['status']='completed' if status in ('completed','succeeded') else status
            if result['read']:
                current.update(notified=True,notification_state='read')
                for run in state['runs']:
                    if run['id']==run_id:
                        run.update(status='silent',summary='执行结果已查看，不再通知',ended_at=utc_now())
                return False
            return terminal
        if not await runtime.mutate(update):
            return
        labels={'completed':'已完成','succeeded':'已完成','failed':'失败','error':'Failed','stopped':'已停止','missing':'不可用'}
        summary=f"委派任务{labels[status]}：{item.get('instruction','')[:100]}\n\n{result['content'] or '请打开执行会话查看结果。'}"
        run={'id':run_id,'created_at':utc_now(),'trigger':'delegation','kind':'work',
             'origin_session_id':item['origin_session_id'],'notification_sources':[item['id']],
             'status':'deferred' if quiet(profile) else 'notifying','summary':summary,
             'sources':{'delegations':[{'id':item['id'],'status':status}]},'deliveries':[]}
        def reserve(state):
            current=next((d for d in state['delegations'] if d['id']==item['id']),None)
            if current is None or current.get('notified'):
                return False
            existing=next((r for r in state['runs'] if r['id']==run_id),None)
            if existing:
                if existing['status']!='deferred':
                    current.update(notified=True,notification_state=existing['status'])
                    return False  # a previous uncertain attempt must not auto-send again
                if quiet(profile):
                    return False
                run['created_at']=existing['created_at']
                existing.update(run)
            else:
                state['runs'].insert(0,run.copy())
                state['runs']=state['runs'][:100]
            if quiet(profile):
                current['notification_state']='deferred'
                return False
            # Persist reservation before external delivery. Ambiguous delivery is
            # recorded for explicit retry; polling never replays external sends.
            current.update(notified=True,notification_state='notifying',notification_run_id=run_id)
            return True
        if not await runtime.mutate(reserve):
            return
        try:
            run['deliveries']=await runtime._notify(summary,[item['id']],run_id)
            run['status']='notified' if run['deliveries'] and all(d['status']=='delivered' for d in run['deliveries']) else 'delivery_failed'
        except Exception as exc:
            run.update(status='failed',error=str(exc)[:500])
        run['ended_at']=utc_now()
        def finish(state):
            for saved in state['runs']:
                if saved['id']==run_id:saved.update(run)
            for saved in state['delegations']:
                if saved['id']==item['id']:saved['notification_state']=run['status']
        await runtime.mutate(finish)
