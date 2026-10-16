import { useEffect, useState } from 'react'
import { scheduleApi, taskApi, type ProjectSchedule, type SchedulePayload, type ScheduleRule, type Task } from '../api/client'
import { useScheduleDraftState, type ScheduleEditorState } from '../hooks/useScheduleDraftState'
import { useI18n } from '../i18n'
import Button from './Button'
import ScheduleRuleEditor from './ScheduleRuleEditor'
import ScheduleNotificationEditor, { type NotificationEditorState } from './ScheduleNotificationEditor'
import Field from './Field'
import Input from './Input'
import Select from './Select'
import TaskPicker from './TaskPicker'
import MarkdownEditor from './MarkdownEditor'
import './TaskScheduleEditor.css'

/** Owns the task-target form, task lookup, preview, validation and save lifecycle. */
export default function TaskScheduleEditor({ projectId, schedule, workflows = [], onSaved, onEditorStateChange }: {
  projectId: string; schedule: ProjectSchedule | null
  workflows?: Array<{ id: string; name: string }>
  onSaved: (schedule: ProjectSchedule) => void
  onEditorStateChange?: (state: ScheduleEditorState) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(schedule?.name || '')
  const [taskId, setTaskId] = useState(schedule?.target_task_id || '')
  const [workflowFilter, setWorkflowFilter] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [instruction, setInstruction] = useState(schedule?.instruction || '')
  const [stop, setStop] = useState(schedule?.stop_condition || 'manual')
  const [rule, setRule] = useState<ScheduleRule>(schedule?.rule || { kind: 'minutes', every: 10, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })
  const [preview, setPreview] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [notification, setNotification] = useState<NotificationEditorState>({value: schedule?.notification || {enabled:false}, valid:true})
  const acceptDefaults = useScheduleDraftState(JSON.stringify({ name, taskId, instruction, stop, rule, notification:notification.value }), revision, true, busy, onEditorStateChange)
  useEffect(() => {
    let active = true
    taskApi.list(projectId).then(result => { if (active) setTasks(result.tasks || []) })
      .catch(cause => { if (active) setError((cause as Error).message) })
    return () => { active = false }
  }, [projectId])
  useEffect(() => {
    let active = true
    setPreview([])
    const timer = window.setTimeout(() => scheduleApi.preview(rule).then(result => {
      if (active) setPreview(result.next_runs)
    }).catch(() => { if (active) setPreview([]) }), 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [rule])
  const selectedWorkflow = schedule ? tasks.find(task => task.id === taskId)?.workflow_id || '' : workflowFilter
  const visibleTasks = tasks.filter(task => !selectedWorkflow || task.workflow_id === selectedWorkflow)
  const changeWorkflow = (workflowId: string) => {
    setWorkflowFilter(workflowId)
    if (workflowId && tasks.find(task => task.id === taskId)?.workflow_id !== workflowId) setTaskId('')
  }
  const save = async () => {
    setBusy(true); setError('')
    const payload: SchedulePayload = { name: name.trim(), target_type: 'task', target_task_id: taskId,
      instruction: instruction.trim(), stop_condition: stop, rule, notification: notification.value, workflow_id: '', task_template: {},
      execution_mode: 'workflow', overlap_policy: 'skip' }
    try {
      const saved = schedule ? await scheduleApi.update(projectId, schedule.id, payload) : await scheduleApi.create(projectId, payload)
      setRevision(value => value + 1)
      onSaved(saved)
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="task-schedule-editor">
    <div className="task-schedule-identification">
    <Field label={t('schedules.ruleName')} required><Input aria-label={t('schedules.ruleName')} value={name} onChange={e => setName(e.target.value)} /></Field>
    <Field label={t('schedules.workflow')}><Select aria-label={t('schedules.workflow')} value={selectedWorkflow} disabled={Boolean(schedule)} onChange={e => changeWorkflow(e.target.value)}>
      <option value="">{t('schedules.allWorkflows')}</option>
      {workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
      {selectedWorkflow && !workflows.some(workflow => workflow.id === selectedWorkflow) && <option value={selectedWorkflow}>{selectedWorkflow}</option>}
    </Select></Field>
    </div>
    <Field label={t('schedules.targetTask')} required><TaskPicker key={selectedWorkflow} tasks={visibleTasks} value={taskId} onChange={setTaskId} disabled={Boolean(schedule)} label={t('schedules.targetTask')} /></Field>
    <Field label={t('schedules.taskInstruction')} required help={t('schedules.taskInstructionHelp')}><MarkdownEditor value={instruction} onChange={setInstruction} projectId={projectId} /></Field>
    <ScheduleRuleEditor value={rule} onChange={setRule} />
    <Field label={t('schedules.stopCondition')}><Select value={stop} onChange={e => setStop(e.target.value as typeof stop)}><option value="manual">{t('schedules.stopManual')}</option><option value="task_terminal">{t('schedules.stopTerminal')}</option></Select></Field>
    <ScheduleNotificationEditor key={taskId} projectId={projectId} taskId={taskId || undefined} initialValue={schedule?.notification}
      onChange={(state, automatic) => { if (automatic) acceptDefaults('notification', state.value); setNotification(state) }} />
    <div className="task-schedule-preview">{t('schedules.nextRuns')}: {preview.slice(0,3).map(value => new Date(value).toLocaleString()).join(' · ') || '—'}</div>
    {error && <div role="alert" className="task-schedule-error">{error}</div>}
    <Button variant="primary" loading={busy} disabled={!name.trim() || !taskId || !instruction.trim() || !preview.length || !notification.valid} onClick={() => void save()}>{t('common.save')}</Button>
  </div>
}
