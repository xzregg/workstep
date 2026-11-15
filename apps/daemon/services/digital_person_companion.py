"""Small persistent companion state, separate from task delivery and source memory.

Pure data transformations: caller persists via the default workspace DB executor.
"""
from datetime import datetime, timedelta, timezone
import re

MOODS = {'calm', 'curious', 'warm', 'happy', 'tired'}


def timestamp(value):
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(value)
        except (TypeError, ValueError):
            return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def contact_interval(minimum, affinity):
    """Higher affinity shortens the interval, never below the configured minimum."""
    return minimum * (3 - 2 * max(0, min(100, affinity)) / 100)


def contact_policy(companion, last_user_at, now, *, interval_minutes=5):
    if companion.get('opted_out'):
        return {'allowed': False, 'reason': '用户已明确要求停止主动联系'}
    last_user = max(filter(None, [timestamp(last_user_at), timestamp(companion.get('last_observed_at'))]), default=None)
    contacts = [timestamp(x.get('at')) for x in companion.get('contacts', [])]
    contacts = [x for x in contacts if x is not None and x > now-timedelta(hours=24)]
    last = max(contacts, default=None)
    if last and (not last_user or last_user <= last):
        return {'allowed': False, 'reason': '上次主动联系后用户尚未回应'}
    if last and now-last < timedelta(minutes=interval_minutes):
        return {'allowed': False, 'reason': '主动联系间隔尚未到，先不打扰'}
    if last_user and now-last_user < timedelta(minutes=1):
        return {'allowed': False, 'reason': '用户刚刚说过话，先留出聊天时间'}
    return {'allowed': True, 'reason': ''}


def observe_user(state, scope, message):
    """Conservative backstop for explicit first-person contact instructions.

    Not a general intent classifier; other preferences remain source-backed text.
    Quoted examples and questions are deliberately not interpreted as commands.
    """
    if not message or message.get('role') != 'user':
        return
    value = state.setdefault('companions', {}).setdefault(scope, {})
    at = timestamp(message.get('created_at'))
    if not at or at <= (timestamp(value.get('last_observed_at')) or datetime.min.replace(tzinfo=timezone.utc)):
        return
    value.update(last_observed_at=at.isoformat(), last_user_message_id=message.get('id'))
    text = str(message.get('content', '')).strip().rstrip('。！!')
    if re.fullmatch(r'(?:请)?(?:不要|别|不用)(?:再)?主动(?:联系|找|关心|打扰|给我发消息)(?:我)?(?:了)?', text):
        value['opted_out'] = True
        value['contact_preference_source'] = message.get('id')
    elif re.fullmatch(r'(?:你)?(?:现在)?(?:可以|允许你|恢复)主动(?:联系|找|关心|给我发消息)(?:我)?(?:了)?', text):
        value['opted_out'] = False
        value['contact_preference_source'] = message.get('id')


def snapshot(state, scope, last_user_at, now, *, interval_minutes=5):
    value = state.get('companions', {}).get(scope, {})
    updated = timestamp(value.get('updated_at'))
    factor = 2 ** (-max(0, (now-updated).total_seconds())/(18*3600)) if updated else 0
    thought = value.get('thought')
    if thought and (timestamp(thought.get('expires_at')) or now) <= now:
        thought = None
    last_contact = max(filter(None, (timestamp(x.get('at')) for x in value.get('contacts', []))), default=None)
    contact_runs = {x.get('run_id') for x in value.get('contacts', []) if x.get('run_id')}
    last_notified = max(filter(None, (timestamp(r.get('notified_at')) for r in state.get('runs', [])
                                      if r.get('id') in contact_runs)), default=None)
    last_user = max(filter(None, [timestamp(last_user_at), timestamp(value.get('last_observed_at'))]), default=None)
    timing = {'now':now.isoformat(),
              'last_contact_attempt_at':last_contact.isoformat() if last_contact else None,
              'last_notification_at':last_notified.isoformat() if last_notified else None,
              'last_user_message_at':last_user.isoformat() if last_user else None,
              'minutes_since_last_contact_attempt':round(max(0,(now-last_contact).total_seconds())/60,1) if last_contact else None,
              'user_spoke_after_last_contact':bool(last_user and last_contact and last_user>last_contact),
              'minimum_interval_minutes':interval_minutes}
    return {'scope': scope, 'mood': value.get('mood', 'calm') if factor >= .1 else 'calm',
            'intensity': round(value.get('intensity', 0)*factor),
            'contact_timing':timing,
            'thought': thought, 'contact_policy': contact_policy(value, last_user_at, now, interval_minutes=interval_minutes)}


def reflect(state, scope, decision, valid_ids, now):
    value = state.setdefault('companions', {}).setdefault(scope, {})
    mood = decision.get('mood')
    if isinstance(mood, str) and mood in MOODS:
        value.update(mood=mood, intensity=60, updated_at=now.isoformat())
    thought = decision.get('thought')
    if not isinstance(thought, dict):
        return
    content, ids, minutes = thought.get('content'), thought.get('source_ids'), thought.get('after_minutes', 60)
    if (not isinstance(content, str) or not content.strip() or not isinstance(ids, list)
            or not ids or any(not isinstance(x, str) or x not in valid_ids for x in ids)
            or isinstance(minutes, bool) or not isinstance(minutes, int) or not 1 <= minutes <= 1440):
        return
    normalized = {'content': content.strip()[:300], 'source_ids': list(dict.fromkeys(ids))}
    old = value.get('thought', {})
    if old.get('content') == normalized['content'] and old.get('source_ids') == normalized['source_ids'] and (timestamp(old.get('expires_at')) or now) > now:
        return
    value['thought'] = {**normalized, 'created_at': now.isoformat(),
                        'not_before': (now+timedelta(minutes=minutes)).isoformat(),
                        'expires_at': (now+timedelta(days=1)).isoformat(), 'status': 'pending'}


def reserve_contact(state, scope, run_id, now):
    value = state.setdefault('companions', {}).setdefault(scope, {})
    value['contacts'] = [x for x in value.get('contacts', []) if (timestamp(x.get('at')) or now) > now-timedelta(hours=48)][-30:]
    value['contacts'].append({'at': now.isoformat(), 'run_id': run_id})
    if value.get('thought'):
        value['thought']['status'] = 'expressed'
