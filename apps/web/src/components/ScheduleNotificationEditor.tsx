import { useEffect, useRef, useState } from 'react'
import { scheduleApi, type ScheduleNotification, type ScheduleNotificationOptions } from '../api/schedule'
import { useI18n } from '../i18n'
import Select from './Select'
import Field from './Field'
import Button from './Button'
import './ScheduleNotificationEditor.css'

export interface NotificationEditorState { value: ScheduleNotification; valid: boolean }

/** Shared task/project channel selection; owns discovery, defaults and validation. */
export default function ScheduleNotificationEditor({ projectId, taskId, initialValue, onChange }: {
  projectId: string; taskId?: string; initialValue?: ScheduleNotification
  onChange: (state: NotificationEditorState, automatic: boolean) => void
}) {
  const { t } = useI18n()
  const callback = useRef(onChange); callback.current = onChange
  const initial = useRef(initialValue)
  const [value, setValue] = useState<ScheduleNotification>(initialValue || {enabled: false})
  const [choices, setChoices] = useState<ScheduleNotificationOptions['choices']>([])
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const selected = choices.find(choice => JSON.stringify(choice.target) === JSON.stringify(value.target))
  const report = (next: ScheduleNotification, list: typeof choices, automatic: boolean) => {
    setValue(next)
    callback.current({value: next, valid: !next.enabled || list.some(choice => JSON.stringify(choice.target) === JSON.stringify(next.target))}, automatic)
  }
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    callback.current({value: initial.current || {enabled: false}, valid: false}, true)
    scheduleApi.notificationOptions(projectId, taskId).then(result => {
      if (!active) return
      setChoices(result.choices)
      report(initial.current || result.default, result.choices, true)
    }).catch(cause => {
      if (!active) return
      setError((cause as Error).message)
      callback.current({value: initial.current || {enabled: false}, valid: false}, true)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId, taskId, reload])
  const bots = [...new Map(choices.map(choice => [choice.bot_id, choice.bot_name])).entries()]
  return <div className="schedule-notification-editor">
    <label className="schedule-notification-toggle"><input type="checkbox" aria-label={t('schedules.notifyChannel')} checked={value.enabled} disabled={loading}
      onChange={event => report(event.target.checked ? {enabled: true, ...(value.target ? {target: value.target} : {})} : {enabled: false}, choices, false)} />
      {t('schedules.notifyChannel')}{loading && <span className="task-status-spinner" />}</label>
    {value.enabled && <div className="schedule-notification-target">
      <Field label={t('schedules.notifyBot')} required><Select aria-label={t('schedules.notifyBot')} value={selected?.bot_id || ''} disabled={loading}
        onChange={event => { const choice = choices.find(item => item.bot_id === event.target.value); report({enabled:true, ...(choice ? {target:choice.target} : {})}, choices, false) }}>
        <option value="">{t('schedules.notifyChooseBot')}</option>{bots.map(([id,name]) => <option key={id} value={id}>{name}</option>)}
      </Select></Field>
      <Field label={t('schedules.notifySession')} required><Select aria-label={t('schedules.notifySession')} value={selected?.id || ''} disabled={loading || !selected?.bot_id}
        onChange={event => { const choice = choices.find(item => item.id === event.target.value); report({enabled:true, ...(choice ? {target:choice.target} : {})}, choices, false) }}>
        <option value="">{t('schedules.notifyChooseSession')}</option>{choices.filter(choice => choice.bot_id === selected?.bot_id).map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </Select></Field>
      {!selected && <div role="alert" className="schedule-notification-hint">{t('schedules.notifyMissingTarget')}</div>}
    </div>}
    {error && <div role="alert" className="schedule-notification-hint">{error}<Button onClick={() => setReload(value => value + 1)}>{t('schedules.notificationReload')}</Button></div>}
  </div>
}
