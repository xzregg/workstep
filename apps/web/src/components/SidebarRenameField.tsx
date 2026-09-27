import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import Input from './Input'
import './SidebarRenameField.css'

interface Props {
  kind: 'project' | 'workflow'
  initialName: string
  onSave: (name: string) => Promise<unknown>
  onClose: () => void
}

/** Inline project/workflow rename with shared validation and retry behavior. */
export default function SidebarRenameField({ kind, initialName, onSave, onClose }: Props) {
  const { t } = useI18n()
  const [name, setName] = useState(initialName)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  const commit = async (fromBlur: boolean) => {
    if (savingRef.current) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === initialName) { onClose(); return }
    if (/\s/.test(name)) {
      setError(t('layout.nameWhitespace'))
      if (fromBlur) onClose()
      return
    }
    savingRef.current = true
    setError('')
    try {
      await onSave(trimmed)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('layout.renameFailed'))
      inputRef.current?.focus()
    } finally {
      savingRef.current = false
    }
  }

  return (
    <span className="sidebar-rename-field" data-kind={kind} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <Input
        ref={inputRef}
        className="sidebar-rename-input"
        value={name}
        aria-invalid={Boolean(error) || /\s/.test(name)}
        onChange={(event) => { setName(event.target.value); setError('') }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void commit(false) }
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
        }}
        onBlur={() => { void commit(true) }}
      />
      {error && <span role="alert" className="sidebar-rename-error">{error}</span>}
    </span>
  )
}
