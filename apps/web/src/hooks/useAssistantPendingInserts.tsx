import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import PendingMessageInserts from '../components/PendingMessageInserts'
import { useI18n } from '../i18n'
import type { AssistantChatMessage } from '../stores/assistantStore'
import {
  pendingInsertQueueKey,
  usePendingMessageInsertStore,
} from '../stores/pendingMessageInsertStore'

const EMPTY_PENDING_INSERTS: never[] = []

interface AssistantPendingInsertOptions {
  projectId: string
  sessionId?: string | null
  messages: Pick<AssistantChatMessage, 'id' | 'role' | 'status' | 'engine'>[]
  input: string
  onInputChange: (value: string) => void
  onSendContent: (content: string, ids: string[]) => Promise<boolean>
  disabled?: boolean
}

/** Owns the queue attached to the currently running assistant message. */
export function useAssistantPendingInserts({
  projectId, sessionId, messages, input, onInputChange, onSendContent, disabled = false,
}: AssistantPendingInsertOptions) {
  const { t } = useI18n()
  const runningMessage = [...messages].reverse().find((message) => (
    message.engine !== 'action' && message.role === 'assistant' && message.status === 'running'
  ))
  const latestAssistant = [...messages].reverse().find((message) => (
    message.engine !== 'action' && message.role === 'assistant'
  ))
  const activeMessageId = runningMessage?.id
    || (latestAssistant?.status === 'stopped' ? latestAssistant.id : '')
  const pendingKey = pendingInsertQueueKey(projectId, activeMessageId)
  const items = usePendingMessageInsertStore((state) => (
    activeMessageId ? state.queues[pendingKey] || EMPTY_PENDING_INSERTS : EMPTY_PENDING_INSERTS
  ))
  const actions = usePendingMessageInsertStore(useShallow((state) => ({
    load: state.load,
    add: state.add,
    update: state.update,
    remove: state.remove,
    clear: state.clear,
    reorder: state.reorder,
  })))
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [sendingIds, setSendingIds] = useState<string[]>([])
  const addingRef = useRef(new Set<string>())
  const sendingRef = useRef(new Set<string>())
  const latest = useRef({ pendingKey, input })
  latest.current = { pendingKey, input }

  useEffect(() => {
    if (!activeMessageId) return
    void actions.load(projectId, activeMessageId).catch((reason) => {
      setError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
    })
  }, [activeMessageId, actions, projectId, t])

  const enqueue = useCallback(async (override?: string): Promise<boolean> => {
    const content = (override ?? input).trim()
    if (disabled || !content || !activeMessageId) return false
    if (addingRef.current.has(pendingKey)) return false
    addingRef.current.add(pendingKey)
    setError('')
    try {
      await actions.add(projectId, activeMessageId, content)
      return true
    } catch (reason) {
      if (latest.current.pendingKey === pendingKey) {
        setError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
      }
      return false
    } finally {
      addingRef.current.delete(pendingKey)
    }
  }, [activeMessageId, actions, disabled, input, pendingKey, projectId, t])

  /** Queues the draft itself, clearing it only if it is still the text that was queued. */
  const queueCurrentInput = useCallback(async (override?: string): Promise<boolean> => {
    const queued = input
    if (!await enqueue(override)) return false
    if (latest.current.pendingKey === pendingKey && latest.current.input === queued) onInputChange('')
    return true
  }, [enqueue, input, onInputChange, pendingKey])

  /** Queues content from another source (voice) and leaves the draft untouched. */
  const queueContent = useCallback((content: string) => enqueue(content), [enqueue])

  const send = useCallback(async (selected: Array<{ id: string; content: string }>) => {
    if (!activeMessageId || selected.length === 0) return
    const eligible = selected.filter((item) => !sendingRef.current.has(item.id))
    const content = eligible.map((item) => item.content.trim()).filter(Boolean).join('\n\n')
    if (!content) return
    const ids = eligible.map((item) => item.id)
    ids.forEach((id) => sendingRef.current.add(id))
    setError('')
    setSendingIds((current) => [...new Set([...current, ...ids])])
    try {
      const sent = await onSendContent(content, ids)
      if (!sent) return
      await Promise.all(eligible.map((item) => actions.remove(projectId, activeMessageId, item.id)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
    } finally {
      ids.forEach((id) => sendingRef.current.delete(id))
      setSendingIds((current) => current.filter((id) => !ids.includes(id)))
    }
  }, [activeMessageId, actions, onSendContent, projectId, t])

  const run = (operation: () => Promise<void>) => {
    setError('')
    void operation().catch((reason) => setError(
      reason instanceof Error ? reason.message : t('chatSession.sendFailed'),
    ))
  }

  const panel = activeMessageId && items.length > 0 ? <PendingMessageInserts
    projectId={projectId}
    items={items}
    disabled={disabled}
    title={t('chatSession.pendingInsertTitle')}
    titleTooltip={t('chatSession.pendingInsertHint')}
    editingId={editingId}
    editingContent={editingContent}
    sendingIds={sendingIds}
    onEditingContentChange={setEditingContent}
    onEditStart={(item) => { setEditingId(item.id); setEditingContent(item.content) }}
    onEditSave={(id) => {
      const content = editingContent.trim()
      if (!content) return
      run(async () => {
        await actions.update(projectId, activeMessageId, id, content)
        setEditingId(null)
        setEditingContent('')
      })
    }}
    onEditCancel={() => { setEditingId(null); setEditingContent('') }}
    onSend={(item) => { void send([item]) }}
    onSendAll={() => { void send(items) }}
    onRemove={(id) => run(() => actions.remove(projectId, activeMessageId, id))}
    onClear={() => run(() => actions.clear(projectId, activeMessageId))}
    onReorder={(fromIndex, toIndex) => run(() => actions.reorder(
      projectId, activeMessageId, fromIndex, toIndex,
    ))}
    reorderHint={t('chatSession.pendingInsertReorderHint')}
  /> : null

  return { panel, error, queueEnabled: Boolean(sessionId && runningMessage), queueCurrentInput, queueContent }
}
