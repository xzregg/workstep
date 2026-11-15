"""One source for the namecard and model-visible digital person statistics."""
import asyncio
import math

from models.chat_session import ChatMessage, ChatSession
from services.skill_center import skill_center


def read_statistics(state):
    """Materialize inside the default workspace's database executor."""
    excluded = state.get('check_sessions', [])
    replies = ChatMessage.select().where(
        ChatMessage.session.not_in(excluded), ChatMessage.role == 'assistant',
        ChatMessage.status.in_(['completed', 'succeeded']),
    )
    reply_count = replies.count()
    negative = [mid for mid, vote in state['feedback'].items() if vote == -1]
    completed = sum(item.get('status') == 'completed' for item in state['delegations'])
    experience = reply_count - replies.where(ChatMessage.id.in_(negative)).count() + completed
    level = min(100, 1 + math.isqrt(experience // 10))
    user_sessions = ChatMessage.select(ChatMessage.session).where(ChatMessage.role == 'user')
    sessions = ChatSession.select().where(ChatSession.id.in_(user_sessions), ChatSession.id.not_in(excluded)).count()
    return dict(experience=experience, level=level, next_level_experience=10 * level * level,
                session_count=sessions, reply_count=reply_count, task_count=len(state['delegations']),
                completed_task_count=completed)


def enabled_skills(project):
    """File discovery stays off the event loop; never inject skill bodies."""
    selection = skill_center.runtime_selection(project.path)
    return [{'id': item.skill_id, 'name': item.name} for item in selection.enabled
            if item.valid and not item.conflict and not item.sync_error]


async def load_identity_snapshot(projects, project):
    from services.digital_person_runtime import read_state
    stats, skills = await asyncio.gather(
        projects.run_db(project.id, lambda _: read_statistics(read_state(project.id))),
        asyncio.to_thread(enabled_skills, project),
    )
    return {**stats, 'skills': skills}


def format_identity_snapshot(snapshot):
    if not snapshot:
        return ''
    if snapshot.get('unavailable'):
        return 'Current runtime statistics are unavailable. Do not infer level, experience, skills, or session counts.'
    skills = snapshot['skills']
    names = ', '.join(item['name'][:60] for item in skills[:20]) or 'None'
    suffix = ' (first 20 only)' if len(skills) > 20 else ''
    return '\n'.join((
        'Current runtime statistics (default workspace, excluding background check sessions):',
        f"Level: Lv.{snapshot['level']}; Experience: {snapshot['experience']}; Next level threshold: {snapshot['next_level_experience']}",
        f"User sessions: {snapshot['session_count']}; Completed replies: {snapshot['reply_count']}; Execution tasks: {snapshot['task_count']}; Completed tasks: {snapshot['completed_task_count']}",
        f"Enabled skills ({len(skills)}): {names}{suffix}",
    ))
