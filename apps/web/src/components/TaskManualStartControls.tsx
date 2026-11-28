import { useRef, useState } from 'react'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import './TaskManualStartControls.css'

interface Props {
  steps: ReadonlyArray<{ key: string; label: string }>
  stepProgress: ReadonlyArray<{ step_key?: string; status?: string }>
  onStart?: (stepKey: string) => Promise<void>
}

/** Starts reached checkpoints without changing the selected step or its history. */
export default function TaskManualStartControls({ steps, stepProgress, onStart }: Props) {
  const { t } = useI18n()
  const pendingRef = useRef(new Set<string>())
  const [pending, setPending] = useState<string[]>([])
  const [error, setError] = useState('')
  const waiting = steps.filter(step => stepProgress.some(progress => progress.step_key === step.key && progress.status === 'awaiting_start'))
  if (!onStart || !waiting.length) return null
  const start = async (key: string) => {
    if (pendingRef.current.has(key)) return
    pendingRef.current.add(key)
    setPending([...pendingRef.current])
    setError('')
    try { await onStart(key) }
    catch (reason) { setError(localizeErrorDisplay(String(reason))) }
    finally { pendingRef.current.delete(key); setPending([...pendingRef.current]) }
  }
  return <div className="task-manual-start-controls">
    <div className="task-manual-start-list">{waiting.map(step => <div className="task-manual-start-item" key={step.key}>
      <span className="task-manual-start-name" title={step.label}>{step.label}</span>
      <Button size="sm" variant={waiting.length === 1 ? 'primary' : 'ghost'} loading={pending.includes(step.key)}
        aria-label={`${t('taskList.start')} · ${step.label}`} onClick={() => void start(step.key)}>
        {!pending.includes(step.key) && <Icon name="play" size={14}/>} {t('taskList.start')}
      </Button>
    </div>)}</div>
    {error && <div className="task-manual-start-error" role="alert">{error}</div>}
  </div>
}
