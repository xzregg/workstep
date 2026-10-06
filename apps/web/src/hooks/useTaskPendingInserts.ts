import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { taskApi } from '../api/client'
import { useI18n } from '../i18n'
import { createOptimisticCoordinatorMessage, createOptimisticUserMessage } from '../pages/taskDetailChat'
import { pendingInsertQueueKey, usePendingMessageInsertStore } from '../stores/pendingMessageInsertStore'
import { randomUuid } from '../utils/uuid'
import { watchPendingCompletion, unwatchPendingCompletion, watchAcceptedCompletion } from '../utils/completionNotifications'

interface Insert { id: string; content: string }

interface Options {
  taskId: string
  projectId: string
  targetMessageId: string | null
  channel: 'coordinator' | 'step'
  targetStepKey: string | null
  activeStepKey: string
  stepRunning: boolean
  setHistoryMessages: Dispatch<SetStateAction<any[]>>
  onCoordinatorRunning: (running: boolean) => void
  onCoordinatorAccepted: (messageId: string) => void
  onFollow: () => void
  onError: (message: string) => void
}

const EMPTY_ITEMS: never[] = []

/** Owns the queued message editor, queue mutations, and immediate sends. */
export function useTaskPendingInserts({
  taskId, projectId, targetMessageId, channel, targetStepKey, activeStepKey,
  stepRunning, setHistoryMessages, onCoordinatorRunning, onCoordinatorAccepted,
  onFollow, onError,
}: Options) {
  const { t } = useI18n()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [sendingIds, setSendingIds] = useState<string[]>([])
  const sendingRef = useRef(new Set<string>())
  const queueKey = projectId && targetMessageId
    ? pendingInsertQueueKey(projectId, targetMessageId) : ''
  const items = usePendingMessageInsertStore((state) => state.queues[queueKey] || EMPTY_ITEMS)
  const actions = usePendingMessageInsertStore(useShallow((state) => ({
    load: state.load, add: state.add, update: state.update, remove: state.remove,
    clear: state.clear, reorder: state.reorder, discard: state.discard,
  })))
  const reportError = useCallback((error: unknown) => onError(
    error instanceof Error ? error.message : t('taskDetail.sendFailed'),
  ), [onError, t])

  useEffect(() => {
    if (!projectId || !targetMessageId) return
    void actions.load(projectId, targetMessageId).catch(reportError)
  }, [actions, projectId, targetMessageId, reportError])

  useEffect(() => {
    setEditingId(null)
    setEditingContent('')
  }, [targetMessageId])

  const add = async (content: string): Promise<boolean> => {
    if (!projectId || !targetMessageId || !content.trim()) return false
    try {
      await actions.add(projectId, targetMessageId, content.trim())
      return true
    } catch (error) {
      reportError(error)
      return false
    }
  }

  const remove = async (id: string) => {
    if (!projectId || !targetMessageId) return
    try { await actions.remove(projectId, targetMessageId, id) }
    catch (error) { reportError(error) }
  }

  const startEdit = (item: Insert) => {
    setEditingId(item.id)
    setEditingContent(item.content)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditingContent('')
  }
  const saveEdit = async (id: string) => {
    const content = editingContent.trim()
    if (!content || !projectId || !targetMessageId) return
    try {
      await actions.update(projectId, targetMessageId, id, content)
      cancelEdit()
    } catch (error) { reportError(error) }
  }

  const clear = async () => {
    if (!projectId || !targetMessageId) return
    try { await actions.clear(projectId, targetMessageId) }
    catch (error) { reportError(error) }
  }
  const reorder = async (fromIndex: number, toIndex: number) => {
    if (!projectId || !targetMessageId) return
    try { await actions.reorder(projectId, targetMessageId, fromIndex, toIndex) }
    catch (error) { reportError(error) }
  }

  const send = async (selected: Insert[]) => {
    if (!taskId || !projectId || !targetMessageId || selected.length === 0) return
    if (channel === 'step' && (!stepRunning || !targetStepKey)) return
    const eligible = selected.filter((item) => !sendingRef.current.has(item.id))
    const content = eligible.map((item) => item.content.trim()).filter(Boolean).join('\n\n')
    if (!content) return
    const ids = eligible.map((item) => item.id)
    ids.forEach((id) => sendingRef.current.add(id))
    setSendingIds((current) => [...new Set([...current, ...ids])])
    const optimisticId = `pending-${randomUuid()}`
    const optimistic = channel === 'coordinator'
      ? createOptimisticCoordinatorMessage(optimisticId, content, activeStepKey, new Date().toISOString())
      : createOptimisticUserMessage(optimisticId, content, targetStepKey!, new Date().toISOString())
    if (channel === 'coordinator') onFollow()
    setHistoryMessages((current) => [...current, optimistic])
    if (channel === 'coordinator') watchPendingCompletion(projectId, { taskId })
    try {
      if (channel === 'coordinator') {
        const accepted = await taskApi.chat(taskId, content, projectId, randomUuid(), ids)
        actions.discard(projectId, targetMessageId, ids)
        setHistoryMessages((current) => current.map((message) => message.id === optimisticId
          ? { ...message, id: accepted.user_message_id, channel: 'coordinator', run_status: 'completed' }
          : message))
        onCoordinatorRunning(true)
        onCoordinatorAccepted(accepted.assistant_message_id)
        watchAcceptedCompletion(projectId, { taskId }, accepted.assistant_message_id)
      } else {
        const accepted = await taskApi.sendStepMessage(taskId, targetStepKey!, content, projectId, false)
        setHistoryMessages((current) => current.map((message) => message.id === optimisticId
          ? { ...message, id: accepted.message_id, run_id: accepted.message_id,
              channel: accepted.channel || 'execution', run_status: 'running',
              sequence: accepted.sequence, created_at: accepted.created_at || message.created_at }
          : message))
        try {
          await Promise.all(eligible.map((item) => actions.remove(projectId, targetMessageId, item.id)))
        } catch (error) { reportError(error) }
      }
    } catch (error) {
      if (channel === 'coordinator') unwatchPendingCompletion(projectId, { taskId })
      setHistoryMessages((current) => current.filter((message) => message.id !== optimisticId))
      reportError(error)
    } finally {
      ids.forEach((id) => sendingRef.current.delete(id))
      setSendingIds((current) => current.filter((id) => !ids.includes(id)))
    }
  }

  return {
    items, sendingIds, editingId, editingContent, setEditingContent,
    add, remove, startEdit, saveEdit, cancelEdit, clear, reorder, send,
  }
}
