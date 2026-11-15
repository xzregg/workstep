"""Displayed terminal-message receipts. Call only inside the project DB executor."""
import json
import uuid
from datetime import datetime
from models.chat_session import ChatMessage, ChatSession, ProjectSetting
from models.fields import utc_now

TERMINAL = {'completed', 'succeeded', 'failed', 'error', 'stopped'}


def _marker(project_id, session_id):
    row=ProjectSetting.get_or_none(ProjectSetting.project_id==project_id,
                                   ProjectSetting.key=='chat_read:'+session_id)
    return json.loads(row.value_json) if row else None


def is_read(project_id, message):
    marker=_marker(project_id,message.session_id)
    return bool(marker and message.status in TERMINAL and
                (marker['message_id']==message.id or
                 message.created_at < datetime.fromisoformat(marker['message_created_at'])))


def mark_read(project_id, session_id, message_id):
    message=(ChatMessage.select(ChatMessage).join(ChatSession).where(
        ChatSession.project_id==project_id,ChatSession.id==session_id,
        ChatMessage.id==message_id,ChatMessage.role=='assistant').get_or_none())
    if message is None:
        raise ValueError('Chat message not found')
    if message.status not in TERMINAL:
        raise ValueError('Chat message is still running')
    if not is_read(project_id,message):
        now=utc_now()
        value=json.dumps({'message_id':message.id,'message_created_at':message.created_at.isoformat(),'read_at':now.isoformat()})
        ProjectSetting.insert(id=str(uuid.uuid4()),project_id=project_id,key='chat_read:'+session_id,
                              value_json=value,updated_at=now).on_conflict(
            conflict_target=[ProjectSetting.project_id,ProjectSetting.key],
            update={ProjectSetting.value_json:value,ProjectSetting.updated_at:now}).execute()
    return {'read':True,'message_id':message.id}
