"""Factual notification audit projection; no content, recipients or config inference."""
import re

from services.memory_secrets import redact


def safe_model_reason(value):
    """Expose a short attributed reason, excluding common credentials and addresses."""
    if not isinstance(value, str):
        return ''
    value = redact(value)
    value = re.sub(r'(?i)\b(?:bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[\"\']?[^\s,，;；\"\']+|sk-[\w-]{12,})', '[凭据已隐藏]', value)
    value = re.sub(r'https?://[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}', '[地址已隐藏]', value)
    value = re.sub(r'(?<!\w)(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|/(?:Users|home|private|tmp)/[^\s，；]+', '[地址已隐藏]', value)
    return value.strip()[:1000]

STATES = {'silent', 'suppressed', 'deferred', 'notifying', 'notified',
          'delivery_failed', 'failed', 'cancelled', 'unknown'}
REASONS = {'model_silent', 'no_work', 'internal_only', 'proactive_disabled',
           'archived_source', 'contact_policy', 'source_busy', 'duplicate',
           'disabled', 'quiet_hours', 'face_welcome', 'target_missing',
           'stale_result', 'invalid_evidence', 'action_not_applicable',
           'delivered', 'delivery_failed', 'no_targets', 'assessment_failed', 'receipt_unavailable', 'unknown'}


def notification_projection(run):
    receipts = run.get('deliveries') or []
    if receipts:
        if any(row.get('status') in ('failed', 'delivery_failed') for row in receipts):
            return {'state': 'delivery_failed', 'reason': 'delivery_failed'}
        if all(row.get('status') == 'delivered' for row in receipts):
            return {'state': 'notified', 'reason': 'delivered'}
    saved = run.get('notification') or {}
    if run.get('status') == 'interrupted' or saved.get('state') == 'notified':
        return {'state':'unknown','reason':'unknown'}
    if saved.get('state') in STATES:
        result = {'state': saved['state'], 'reason': saved.get('reason') if saved.get('reason') in REASONS else 'unknown'}
        if reason := safe_model_reason(run.get('model_notification_reason') or (saved.get('model_reason') if result['reason'] == 'model_silent' else None)):
            result['model_reason'] = reason
        return result
    status = run.get('status')
    state = status if status in STATES and status != 'notified' else 'unknown'
    reason = 'assessment_failed' if status == 'failed' else 'delivery_failed' if status == 'delivery_failed' else 'unknown'
    return {'state': state, 'reason': reason}


def notification_audit(run, runs):
    by_id = {row['id']: row for row in runs}
    notices = []
    for notice in run.get('delegation_notifications') or []:
        # Follow only an explicitly recorded link; never join legacy tasks by similarity.
        linked = by_id.get(notice.get('run_id'))
        if notice.get('run_id') and linked is None:
            notices.append({'state':'unknown','reason':'receipt_unavailable'})
        else:
            notices.append(notification_projection(linked or {'notification': notice}))
    return {'notification': notification_projection(run), 'delegation_notifications': notices}


def delivery_failure_reason(error):
    # Transport exceptions may contain URLs, addresses, IDs or credentials.
    known = {
        '来源会话已归档': '来源会话已归档',
        'The source project for the notification does not exist': '通知来源项目已不存在',
        'The source session of the notification has been archived or deleted': '通知目标会话已归档或删除',
        'Notification binding has been disconnected or disabled. Please reselect the receiving session.': '通知绑定已断开或关闭，请重新选择接收会话',
    }
    return known.get(error, '通知投递失败；详细错误保留在本机运行记录中。')
