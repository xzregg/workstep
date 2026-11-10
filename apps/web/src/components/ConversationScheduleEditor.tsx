import { useEffect, useState } from 'react'
import { scheduleApi, type ProjectSchedule, type SchedulePayload, type ScheduleRule } from '../api/schedule'
import { useChatListStore } from '../stores/chatSessionStore'
import { useScheduleDraftState, type ScheduleEditorState } from '../hooks/useScheduleDraftState'
import { useI18n } from '../i18n'
import Button from './Button'
import Field from './Field'
import Input from './Input'
import Select from './Select'
import MarkdownEditor from './MarkdownEditor'
import ScheduleRuleEditor from './ScheduleRuleEditor'
import './TaskScheduleEditor.css'

/** Owns conversation lookup, validation, preview and persistence in the shared schedule page. */
export default function ConversationScheduleEditor({ projectId, schedule, onSaved, onEditorStateChange }: {
  projectId: string; schedule: ProjectSchedule | null
  onSaved: (value: ProjectSchedule) => void
  onEditorStateChange?: (value: ScheduleEditorState) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(schedule?.name || '')
  const [sessionId, setSessionId] = useState(schedule?.target_session_id || '')
  const [instruction, setInstruction] = useState(schedule?.instruction || '')
  const [rule, setRule] = useState<ScheduleRule>(schedule?.rule || { kind: 'minutes', every: 10, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })
  const [preview, setPreview] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const sessions = useChatListStore(state => state.sessionsByProject[projectId])
  const loading = useChatListStore(state => state.listLoadingByProject[projectId])
  const loadError = useChatListStore(state => state.listErrorByProject[projectId])
  const fetchSessions = useChatListStore(state => state.fetchSessions)
  const selected = sessions?.find(session => session.id === sessionId && !session.archived)
  useScheduleDraftState(JSON.stringify({ name, sessionId, instruction, rule }), revision, true, busy, onEditorStateChange)
  useEffect(() => { void fetchSessions(projectId, true) }, [projectId, fetchSessions])
  useEffect(() => {
    let active = true
    setPreview([])
    const timer = window.setTimeout(() => scheduleApi.preview(rule).then(result => { if (active) setPreview(result.next_runs) }).catch(() => { if (active) setPreview([]) }), 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [rule])
  const save = async () => {
    setBusy(true); setError('')
    const payload: SchedulePayload = { name: name.trim(), target_type: 'session', target_session_id: sessionId,
      instruction: instruction.trim(), rule, workflow_id: '', task_template: {}, execution_mode: 'workflow', overlap_policy: 'skip' }
    try {
      const value = schedule ? await scheduleApi.update(projectId, schedule.id, payload) : await scheduleApi.create(projectId, payload)
      setRevision(value => value + 1); onSaved(value)
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="task-schedule-editor conversation-schedule-editor">
    <Field label={t('schedules.ruleName')} required><Input aria-label={t('schedules.ruleName')} value={name} onChange={e => setName(e.target.value)} /></Field>
    <Field label={t('schedules.targetSession')} required><Select aria-label={t('schedules.targetSession')} value={sessionId} disabled={Boolean(schedule) || loading} onChange={e => setSessionId(e.target.value)}>
      <option value="">{t('schedules.selectSession')}</option>
      {(sessions || []).filter(session => !session.archived).map(session => <option key={session.id} value={session.id}>{session.title || session.id} ({session.source === 'channel' ? session.channel_platform || t('schedules.channelConversation') : t('schedules.localConversation')})</option>)}
    </Select></Field>
    {loading && <span className="task-status-spinner" />}
    {loadError && <div role="alert" className="task-schedule-error">{loadError}<Button onClick={() => void fetchSessions(projectId, true)}>{t('schedules.notificationReload')}</Button></div>}
    <Field label={t('schedules.sessionInstruction')} required><MarkdownEditor value={instruction} onChange={setInstruction} projectId={projectId} /></Field>
    <ScheduleRuleEditor value={rule} onChange={setRule} />
    {selected && <div className="task-schedule-preview">{selected.source === 'channel'
      ? <>{t('schedules.sessionChannelReply')}<br />{[selected.channel_platform, selected.channel_name, selected.channel_peer_name || selected.channel_group_name].filter(Boolean).join(' / ')}</>
      : t('schedules.sessionLocalReply')}</div>}
    <div className="conversation-schedule-lifecycle">{t('schedules.sessionLifecycle')}</div>
    <div className="task-schedule-preview">{t('schedules.nextRuns')}: {preview.slice(0, 3).map(value => new Date(value).toLocaleString()).join(' / ') || '—'}</div>
    {error && <div role="alert" className="task-schedule-error">{error}</div>}
    <Button variant="primary" data-save-session-schedule loading={busy} disabled={!name.trim() || !selected || !instruction.trim() || !preview.length || loading || Boolean(loadError)} onClick={() => void save()}>{t('common.save')}</Button>
  </div>
}
