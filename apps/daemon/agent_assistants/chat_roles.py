"""Chat prompt assets: durable references and per-engine injection checkpoints.

Sync methods run only inside the project DB worker or prompt-building thread.
The binding and checkpoint never contain role prompt copies.
"""
import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from agent_assistants.chat_row_persistence import _load_json
from engines.core.registry import create_engine
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from services.channels.session_source import channel_session_source
from services.role_center import role_center


class RoleBinding(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['role', 'team']
    id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')


def resolve_binding(binding: dict | None) -> tuple[str, str]:
    if binding is None:
        return '', ''
    ref = RoleBinding.model_validate(binding)
    # Freeze all team members within the same library read unit.
    with role_center._lock:
        if ref.kind == 'role':
            role = role_center.get_role(ref.id)
            return role['name'], f"### Role: {role['name']}\n{role['prompt']}"
        team = role_center.get_team(ref.id)
        parts = [f"### Expert team: {team['name']}", team['prompt'],
                 'Use the following perspectives in this conversation. Member order is guidance, not separate agent execution.']
        for index, member in enumerate(team['members'], 1):
            role = role_center.get_role(member['role_id'])
            parts.append(f"### {index}. {role['name']}\nRole reference: {member['role_id']}\n{role['prompt']}\nAssignment: {member['duty'] or 'Apply your expertise to the current request.'}")
        text = '\n\n'.join(parts)
        if len(text) > 200_000:
            raise ValueError('专家团提示词总长度不能超过 200000 字，请精简后再使用')
        return team['name'], text


class ChatRoleBindings:
    def get_role_binding(self, project_id: str, session_id: str) -> dict:
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                raise ValueError('Chat session not found')
            if channel_session_source(row.id, row.title).get('source') == 'channel':
                return {'binding': None, 'name': '', 'missing': False, 'supported': False}
            binding = _load_json(row.role_binding_json, None)
        try:
            name, _ = resolve_binding(binding)
            return {'binding': binding, 'name': name, 'missing': False}
        except (ValueError, OSError):
            return {'binding': binding, 'name': (binding or {}).get('id', ''), 'missing': True}

    def set_role_binding(self, project_id: str, session_id: str, binding: dict | None) -> dict:
        if binding is not None:
            binding = RoleBinding.model_validate(binding).model_dump()
        with self._project_ctx(project_id):
            row = ChatSession.get_or_none(ChatSession.id == session_id)
            if row is None:
                raise ValueError('Chat session not found')
            if channel_session_source(row.id, row.title).get('source') == 'channel':
                raise ValueError('渠道会话暂不支持加载角色')
            if any(state.get('session_id') == session_id and state.get('status') in {'queued', 'running', 'stopping'}
                   for state in self._turn_states.values()) or ChatMessage.select().where(
                       ChatMessage.session == row, ChatMessage.status == 'running').exists():
                raise ValueError('Chat session is running: 对话运行中，不能切换角色')
            name, _ = resolve_binding(binding)
            removing = binding is None and bool(row.role_binding_json)
            row.role_binding_json = json.dumps(binding) if binding else None
            if removing:
                # Even a failed/unsent first injection may have reached the
                # engine. Explicit removal must not rely on a success record.
                row.role_checkpoint_json = json.dumps({'clear_pending': True})
            row.updated_at = utc_now()
            row.save(only=[ChatSession.role_binding_json, ChatSession.role_checkpoint_json, ChatSession.updated_at])
            memory = self._sessions.get(self._session_identity(project_id, session_id)[0])
            if memory is not None:
                memory.extra['role_binding'] = binding
                if removing:
                    memory.extra['role_checkpoint'] = {'clear_pending': True}
        return {'binding': binding, 'name': name, 'missing': False}

    def _with_role_prompt(self, session, prompt: str, *, force=False) -> str:
        if self._config.name != 'chat_session':
            return prompt
        session.extra.pop('pending_role_checkpoint', None)
        user = next((str(item.get('content') or '') for item in reversed(session.messages)
                     if item.get('role') == 'user'), '')
        # Preserve native control-command recognition. Its compaction event
        # invalidates the checkpoint without wrapping /compact in instructions.
        if user.strip() == '/compact' or user.strip().startswith('/goal '):
            return prompt
        binding = session.extra.get('role_binding')
        try:
            _, body = resolve_binding(binding)
        except FileNotFoundError as exc:
            raise ValueError('角色或专家团成员不存在，请重新选择') from exc
        fingerprint = hashlib.sha256((json.dumps(binding, sort_keys=True) + '\n' + body).encode()).hexdigest()
        engine = create_engine(session.engine)
        context_id = session.resolved_session_id if not force and engine and engine.supports_resume else None
        previous = session.extra.get('role_checkpoint') or {}
        current = {'engine': session.engine, 'session_id': context_id, 'fingerprint': fingerprint}
        if binding is None and not previous:
            return prompt
        if context_id and previous == current:
            return prompt
        session.extra['pending_role_checkpoint'] = {
            **current, 'epoch': session.extra.get('role_context_epoch', 0),
        }
        instruction = body or 'The previously loaded role/team instructions no longer apply. Continue without an assigned expert role.'
        return ('## Current conversation role instructions\n'
                'This block replaces any previously assigned expert identity. Follow existing project rules and permissions.\n'
                + instruction + '\n\n## Current user input\n' + prompt)

    async def _on_context_compacted(self, session) -> None:
        await super()._on_context_compacted(session)
        if self._config.name == 'chat_session':
            session.extra['role_context_epoch'] = session.extra.get('role_context_epoch', 0) + 1
            session.extra['role_checkpoint'] = None
            await self._persist_session(session)

    async def _parse_response(self, session, raw):
        result = await super()._parse_response(session, raw)
        pending = session.extra.pop('pending_role_checkpoint', None)
        if pending and pending['epoch'] == session.extra.get('role_context_epoch', 0):
            session.extra['role_checkpoint'] = {
                'engine': session.engine, 'session_id': session.resolved_session_id,
                'fingerprint': pending['fingerprint'],
            }
        return result
