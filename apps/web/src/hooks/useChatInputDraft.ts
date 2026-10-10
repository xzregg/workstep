import { useEffect, useRef } from 'react'
import { loadDraft, loadTaskDraft, saveDraft, saveTaskDraft } from '../utils/chatDraft'

type DraftOwner = { type: 'session' | 'task'; id: string }

function readDraft(owner: DraftOwner): string {
  return owner.type === 'task' ? loadTaskDraft(owner.id) : loadDraft(owner.id)
}

function writeDraft(owner: DraftOwner, value: string): void {
  if (owner.type === 'task') saveTaskDraft(owner.id, value)
  else saveDraft(owner.id, value)
}

/** Keeps the visible composer value and its persisted owner in sync across session/task switches. */
export function useChatInputDraft({
  sessionId, taskId, value, onChange,
}: {
  sessionId?: string | null
  taskId?: string | null
  value: string
  onChange: (value: string) => void
}) {
  const draftOwnerRef = useRef<DraftOwner | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  // The parent echo caused by restoring a draft must not be treated as user
  // input; a real edit produces a different value and saves normally.
  const restoredValueRef = useRef<string | null>(null)
  const beforeRestoreRef = useRef<string | null>(null)

  useEffect(() => {
    const previous = draftOwnerRef.current
    const next = taskId
      ? { type: 'task' as const, id: taskId }
      : sessionId
        ? { type: 'session' as const, id: sessionId }
        : null
    const ownerChanged = previous?.id !== next?.id || previous?.type !== next?.type
    if (ownerChanged) {
      if (previous) writeDraft(previous, restoredValueRef.current ?? valueRef.current)
      restoredValueRef.current = null
      beforeRestoreRef.current = null
      draftOwnerRef.current = next
      if (!next) return
      const restored = readDraft(next)
      if (restored !== valueRef.current) {
        restoredValueRef.current = restored
        beforeRestoreRef.current = valueRef.current
        onChange(restored)
      }
      return
    }
    if (restoredValueRef.current !== null && value === beforeRestoreRef.current) return
    if (restoredValueRef.current === value) {
      restoredValueRef.current = null
      return
    }
    restoredValueRef.current = null
    if (next) writeDraft(next, value)
  }, [sessionId, taskId, value, onChange])

  useEffect(() => () => {
    const owner = draftOwnerRef.current
    if (owner) writeDraft(owner, restoredValueRef.current ?? valueRef.current)
  }, [])

  return valueRef
}
