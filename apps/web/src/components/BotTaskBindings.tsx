import { useState } from 'react'
import { channelBotApi, type BotTaskBinding } from '../api/channelBots'
import { useI18n } from '../i18n'
import Button from './Button'
import './BotTaskBindings.css'

export default function BotTaskBindings({ bindings, onChanged }: {
  bindings?: BotTaskBinding[]
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState('')
  const unbind = async (binding: BotTaskBinding, key: string) => {
    setBusyKey(key)
    setError('')
    try {
      await channelBotApi.unbindGroup(binding.task_id, binding.project_id, binding.bot_id, binding.group_id)
      await onChanged()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusyKey(null)
    }
  }
  return <section className="bot-task-bindings" aria-label={t('channelBot.boundTasks')}>
    <span className="bot-task-bindings-label">{t('channelBot.boundTasks')}</span>
    {bindings === undefined ? <p>{t('channelBot.bindingsUnavailable')}</p>
      : bindings.length === 0 ? <p>{t('channelBot.noBoundTasks')}</p> : <ul>{bindings.map((binding) => {
      const key = JSON.stringify([binding.project_id, binding.task_id, binding.group_id])
      const label = `${t('channelBot.unbindTask')} · ${binding.task_title}`
      return <li key={key}>
        <div><strong>{binding.task_title}</strong><span>{binding.project_name} · {binding.group_name || binding.group_id}</span></div>
        <Button variant="icon" className="bot-task-binding-remove" title={label} aria-label={label}
          loading={busyKey === key} disabled={busyKey !== null} onClick={() => void unbind(binding, key)}>
          {busyKey !== key && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>}
        </Button>
      </li>
    })}</ul>}
    {error && <p className="bot-task-bindings-error" role="alert">{error}</p>}
  </section>
}
