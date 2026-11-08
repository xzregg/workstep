import { useEffect, useState } from 'react'
import { assistantApi } from '../api/client'
import Button from '../components/Button'
import ConcurrencyLimitInput from '../components/ConcurrencyLimitInput'
import Input from '../components/Input'
import { useI18n } from '../i18n'
import './GlobalConcurrencySettings.css'

const fieldStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 6,
}

function parseLimit(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null
}

export default function GlobalConcurrencySettings() {
  const { t } = useI18n()
  const [maxTasks, setMaxTasks] = useState('0')
  const [retryMinutes, setRetryMinutes] = useState('5')
  const [maxChats, setMaxChats] = useState('0')
  const [scheduleExempt, setScheduleExempt] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    assistantApi.concurrencyConfig()
      .then((config) => {
        if (!active) return
        setMaxTasks(String(config.max_tasks))
        setRetryMinutes(String(config.task_retry_interval_minutes ?? 5))
        setMaxChats(String(config.max_chats))
        setScheduleExempt(config.schedule_exempt)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : t('projectSettings.loadFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [t])

  const taskLimit = parseLimit(maxTasks)
  const chatLimit = parseLimit(maxChats)
  const retryInterval = parseLimit(retryMinutes)
  const invalidRetry = retryInterval === null || !Number.isSafeInteger(retryInterval) || retryInterval > 10080
  const invalid = taskLimit === null || chatLimit === null
    || invalidRetry
    || (maxTasks !== '0' && taskLimit < 1)
    || (maxChats !== '0' && chatLimit < 1)

  const save = async () => {
    if (invalid || saving) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const config = await assistantApi.setConcurrencyConfig({
        max_tasks: taskLimit,
        max_chats: chatLimit,
        schedule_exempt: scheduleExempt,
        task_retry_interval_minutes: retryInterval!,
      })
      setMaxTasks(String(config.max_tasks))
      setRetryMinutes(String(config.task_retry_interval_minutes ?? 5))
      setMaxChats(String(config.max_chats))
      setScheduleExempt(config.schedule_exempt)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('projectSettings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>
        {t('projectSettings.concurrency.title')}
      </h1>
      <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))', marginBottom: 22 }}>
        {t('projectSettings.concurrency.hint')}
      </p>

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--meta)' }}>{t('common.loading')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
            <div className="global-concurrency-task-fields">
              <label style={fieldStyle} htmlFor="global-max-tasks">
                <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
                  {t('projectSettings.concurrency.maxTasks')}
                </span>
                <ConcurrencyLimitInput
                  id="global-max-tasks"
                  value={maxTasks}
                  unlimitedLabel={t('projectSettings.concurrency.unlimited')}
                  onValueChange={(value) => { setMaxTasks(value); setSaved(false) }}
                />
              </label>
              <label className="global-concurrency-retry-field" htmlFor="global-task-retry-interval">
                <span>{t('projectSettings.concurrency.taskRetryInterval')}</span>
                <Input id="global-task-retry-interval" type="number" min={0} max={10080} step={1}
                  value={retryMinutes} aria-describedby="global-task-retry-hint"
                  onChange={(event) => { setRetryMinutes(event.target.value); setSaved(false) }} />
                <small id="global-task-retry-hint">{t('projectSettings.concurrency.taskRetryHint')}</small>
              </label>
            </div>
            <label style={fieldStyle} htmlFor="global-max-chats">
              <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
                {t('projectSettings.concurrency.maxChats')}
              </span>
              <ConcurrencyLimitInput
                id="global-max-chats"
                value={maxChats}
                unlimitedLabel={t('projectSettings.concurrency.unlimited')}
                onValueChange={(value) => { setMaxChats(value); setSaved(false) }}
              />
            </label>
          </div>
          <label
            htmlFor="global-schedule-exempt"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}
          >
            <Input
              id="global-schedule-exempt"
              type="checkbox"
              checked={scheduleExempt}
              onChange={(event) => { setScheduleExempt(event.target.checked); setSaved(false) }}
            />
            <span>
              <span style={{ display: 'block', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
                {t('projectSettings.concurrency.scheduleExempt')}
              </span>
              <span style={{ display: 'block', marginTop: 3, color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
                {t('projectSettings.concurrency.scheduleExemptHint')}
              </span>
            </span>
          </label>
          {invalid && (
            <div role="alert" style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>
              {t(invalidRetry ? 'projectSettings.concurrency.taskRetryInvalid' : 'projectSettings.concurrency.positiveInteger')}
            </div>
          )}
          {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>{error}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button variant="primary" loading={saving} disabled={invalid || saving} onClick={() => void save()}>
              {t('common.save')}
            </Button>
            {saved && (
              <span role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>
                {t('projectSettings.concurrency.saved')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
