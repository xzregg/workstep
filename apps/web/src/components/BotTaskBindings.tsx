import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { channelBotApi, type BotTaskBinding } from '../api/channelBots'
import { useI18n } from '../i18n'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import { useOverlay } from '../hooks/useOverlay'
import { useCompactLayout } from '../hooks/useCompactLayout'
import './BotTaskBindings.css'

export default function BotTaskBindings({ bindings, onChanged }: {
  bindings?: BotTaskBinding[]
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const compact = useCompactLayout()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState('')
  const close = () => { if (busyKey === null) setOpen(false) }
  useOverlay(open, close, dialogRef, compact)
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
  return <>
    <Button variant="ghost" className="bot-task-bindings-trigger" onClick={() => { setError(''); setOpen(true) }}>
      {t('channelBot.boundTasks')}{bindings !== undefined && ` (${bindings.length})`}
    </Button>
    {open && createPortal(<div className="bot-task-bindings-backdrop" onClick={close}>
      <ResizablePanel ref={dialogRef} className="bot-task-bindings-dialog" role="dialog" aria-modal="true" aria-label={t('channelBot.boundTasks')} tabIndex={-1}
        minWidth={320} minHeight={240} onClick={event => event.stopPropagation()}>
        <header className="bot-task-bindings-header" data-dialog-drag-handle>
          <strong>{t('channelBot.boundTasks')}{bindings !== undefined && ` (${bindings.length})`}</strong>
          <Button variant="icon" className="bot-task-bindings-close" aria-label={t('settings.closeSettings')} disabled={busyKey !== null} onClick={close}>✕</Button>
        </header>
        <section className="bot-task-bindings" aria-label={t('channelBot.boundTasks')}>
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
        </section>
        {error && <p className="bot-task-bindings-error" role="alert">{error}</p>}
      </ResizablePanel>
    </div>, document.body)}
  </>
}
