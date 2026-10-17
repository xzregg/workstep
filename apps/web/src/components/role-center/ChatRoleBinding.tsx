import { useEffect, useRef, useState, type ReactNode } from 'react'
import { chatRoleApi, type ChatRoleReference, type ChatRoleState } from '../../api/chatRoles'
import type { ChatInputRoleBinding } from '../ChatInput'
import RoleAssetPicker from './RoleAssetPicker'
import './ChatRoleBinding.css'

interface Props {
  projectId: string; sessionId: string; running: boolean; enabled?: boolean
  children: (control: ChatInputRoleBinding | undefined) => ReactNode
}

/** Owns binding requests, picker and failure recovery; callers pass only scope. */
export default function ChatRoleBinding({ projectId, sessionId, running, enabled = true, children }: Props) {
  const [state, setState] = useState<ChatRoleState>({ binding: null, name: '', missing: false })
  const [loading, setLoading] = useState(enabled)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!enabled) return
    let active = true
    setLoading(true); setError('')
    chatRoleApi.get(sessionId, projectId).then(value => { if (active) setState(value) })
      .catch(reason => { if (active) setError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [enabled, projectId, sessionId, retry])

  const save = async (binding: ChatRoleReference | null) => {
    if (running || loading || saving) return false
    setSaving(true); setError('')
    try {
      const value = await chatRoleApi.set(sessionId, projectId, binding)
      if (mounted.current) { setState(value); setOpen(false) }
      return true
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally { if (mounted.current) setSaving(false) }
  }
  if (!enabled || state.supported === false) return children(undefined)
  return <>
    {children({ name: state.name, missing: state.missing, loading: loading || saving,
      disabled: running || loading || saving, error: open ? '' : error,
      onOpen: () => { if (!running && !loading && !saving) setOpen(true) },
      onRemove: () => { void save(null) }, onRetry: () => setRetry(value => value + 1) })}
    {open && <RoleAssetPicker binding={state.binding} busy={saving || running} error={error}
      onSelect={save} onClose={() => { if (!saving) { setOpen(false); setError('') } }} />}
  </>
}
