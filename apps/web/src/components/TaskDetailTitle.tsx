import { useCallback, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useTaskStore } from '../stores/taskStore'
import Spinner from './Spinner'

interface Props {
  task: { id: string; title: string }
  projectId?: string
  editable?: boolean
}

/** Owns inline title editing, validation and failed-save recovery. */
export default function TaskDetailTitle({ task, projectId, editable = false }: Props) {
  const { t } = useI18n()
  const renameTask = useTaskStore((state) => state.renameTask)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const cancelled = useRef(false)
  const focusInput = useCallback((input: HTMLInputElement | null) => {
    if (input) { input.focus(); input.select() }
  }, [])
  const canEdit = editable && !!projectId
  const save = async () => {
    if (!canEdit || pending.current || cancelled.current) return
    const title = draft.trim()
    if (!title) { setError(t('taskDetail.titleRequired')); return }
    if (title === task.title) { setEditing(false); return }
    pending.current = true
    setSaving(true)
    setError('')
    try {
      await renameTask(task.id, title, projectId!)
      setEditing(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('taskDetail.titleSaveFailed'))
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return <span data-task-title className="task-title-editor"
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onDoubleClick={(event) => {
      event.stopPropagation()
      if (!canEdit || editing) return
      cancelled.current = false
      setDraft(task.title); setError(''); setEditing(true)
    }} title={canEdit && !editing ? t('taskDetail.renameTitleHint') : undefined}>
    {editing && canEdit ? <>
      <input className="task-title-input" value={draft} autoFocus
        ref={focusInput}
        aria-label={t('taskDetail.taskTitle')} aria-invalid={!!error} disabled={saving}
        onChange={(event) => { setDraft(event.target.value); setError('') }}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); void save() }
          if (event.key === 'Escape' && !pending.current) {
            cancelled.current = true; setEditing(false); setError('')
          }
        }} />
      {saving && <Spinner />}
      {error && <span className="task-title-error" role="alert">{error}</span>}
    </> : task.title}
  </span>
}
