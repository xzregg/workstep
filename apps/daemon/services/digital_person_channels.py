"""Explicit channel peers, independent of each bot's default project route."""
import asyncio
import uuid
from services.config import config_store

KEY = 'digital_person_channels'
_lock = asyncio.Lock()

def peer_id(peer):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"workstep-channel:{peer['bot_id']}:{peer['conversation_type']}:{peer['conversation_id']}"))


def get_bindings():
    # Read old records without depending on the original chat's lifetime.
    return [{**{k:v for k,v in row.items() if k not in {'session_id','project_id'}},
             'id': peer_id(row)} for row in config_store.get(KEY, [])]

async def available(manager, projects):
    catalog = await asyncio.to_thread(projects.list_project_catalog)
    rows = []
    for project in catalog:
        result = await manager.list_channel_sessions(project['id'])
        rows.extend(result['sessions'])
    data = await manager._load()
    for bot in data['bots']:
        common = {'bot_id':bot['id'], 'bot_name':bot['name'], 'platform':bot['platform']}
        for group in data['recent_groups']:
            if group['bot_id'] == bot['id']:
                rows.append({**common, 'conversation_type':'group', 'conversation_id':group['group_id'],
                             'title':group.get('group_name') or group['group_id']})
        users = {**manager._private_users.get(bot['id'], {})}
        for user in bot.get('private_whitelist', {}).get('users', []):
            users.setdefault(user['sender_id'], user)
        for user in users.values():
            rows.append({**common, 'conversation_type':'single', 'conversation_id':user['sender_id'],
                         'title':user.get('sender_name') or user['sender_id']})
    return list({peer_id(row): {**{k:v for k,v in row.items() if k not in {'session_id','project_id'}},
                              'id':peer_id(row)} for row in rows}.values())

async def bind(manager, projects, bot_id, conversation_type, conversation_id, notify=False):
    rows = await available(manager, projects)
    peer = next((r for r in rows if (r['bot_id'],r['conversation_type'],r['conversation_id']) ==
                 (bot_id,conversation_type,conversation_id)), None)
    if peer is None:
        raise ValueError('Please select an identified channel group chat or contact')
    value = {key:peer[key] for key in ('id','bot_id','conversation_type','conversation_id','title','bot_name','platform')}
    value.update(notify=notify)
    async with _lock:
        current = await asyncio.to_thread(get_bindings)
        current = [r for r in current if not (r['bot_id']==value['bot_id'] and r['conversation_id']==value['conversation_id'] and r['conversation_type']==value['conversation_type'])]
        await asyncio.to_thread(config_store.set, KEY, [*current,value])
    return value

async def unbind(binding_id):
    async with _lock:
        current = await asyncio.to_thread(get_bindings)
        await asyncio.to_thread(config_store.set, KEY, [r for r in current if r['id']!=binding_id])


async def send_binding(manager, binding, text):
    from services.channels.bots import IncomingMessage
    data = await manager._load()
    bot = next((b for b in data['bots'] if b['id'] == binding['bot_id']), None)
    adapter = manager._adapters.get(binding['bot_id'])
    if not bot or not bot['enabled'] or adapter is None:
        raise ValueError('The bot is disabled or disconnected')
    recipient = IncomingMessage(binding['bot_id'], str(uuid.uuid4()), binding['conversation_type'],
                                binding['conversation_id'], '', '')
    await adapter.send_text(recipient, text)
    return {'sent':True, 'message_id':recipient.message_id}
