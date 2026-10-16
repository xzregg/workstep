import { useEffect, useRef, type MutableRefObject } from 'react'

/** Load existing history pages until a linked message is available, then reveal it. */
export function useTaskMessageFocus(messageId: string | undefined, messages: Array<{ id: string }>, loading: boolean,
  loadOlder: () => Promise<void>, follow: MutableRefObject<boolean>) {
  const progress = useRef({ id: '', count: -1, done: false })
  useEffect(() => {
    if (!messageId || loading || !messages.length) return
    if (progress.current.id !== messageId) progress.current = { id: messageId, count: -1, done: false }
    if (progress.current.done) return
    follow.current = false
    if (messages.some(message => message.id === messageId)) {
      const frame = requestAnimationFrame(() => {
        const element = [...document.querySelectorAll<HTMLElement>('[data-task-message-id]')].find(item => item.dataset.taskMessageId === messageId)
        element?.scrollIntoView({ block: 'center', behavior: 'instant' })
        element?.focus({ preventScroll: true })
        if (element) progress.current.done = true
      })
      return () => cancelAnimationFrame(frame)
    }
    if (progress.current.count === messages.length) return
    progress.current.count = messages.length
    void loadOlder()
  }, [messageId, messages, loading, loadOlder, follow])
}
