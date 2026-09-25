import { useCallback, useEffect, useState } from 'react'
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
}

/** Owns the queue attached to the currently running assistant message. */
export function useAssistantPendingInserts({
  projectId, sessionId, messages, input, onInputChange, onSendContent,
}: AssistantPendingInsertOptions) {
  const { t } = useI18n()
  const activeMessageId = [...messages].reverse().find((message) => (
    message.engine !== 'action' && message.role === 'assistant' && message.status === 'running'
  ))?.id || ''
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

  useEffect(() => {
    if (!activeMessageId) return
    void actions.load(projectId, activeMessageId).catch((reason) => {
      setError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
    })
  }, [activeMessageId, actions, projectId, t])

  const queueCurrentInput = useCallback(async () => {
    const content = input.trim()
    if (!content || !activeMessageId) return
    setError('')
    try {
      await actions.add(projectId, activeMessageId, content)
      onInputChange('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
    }
  }, [activeMessageId, actions, input, onInputChange, projectId, t])

  const send = useCallback(async (selected: Array<{ id: string; content: string }>) => {
    if (!activeMessageId || selected.length === 0) return
    const content = selected.map((item) => item.content.trim()).filter(Boolean).join('\n\n')
    if (!content) return
    const ids = selected.map((item) => item.id)
    setError('')
    setSendingIds((current) => [...new Set([...current, ...ids])])
    try {
      const sent = await onSendContent(content, ids)
      if (!sent) return
      await Promise.all(selected.map((item) => actions.remove(projectId, activeMessageId, item.id)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
    } finally {
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
    items={items}
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

  return { panel, error, queueEnabled: Boolean(sessionId && activeMessageId), queueCurrentInput }
}
