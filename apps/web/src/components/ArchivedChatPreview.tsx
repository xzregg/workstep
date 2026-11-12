import { useEffect, useState } from 'react'
import { chatSessionApi, type WorkflowGenHistoryMessage } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import ChatMessageBubble from './ChatMessageBubble'
import Spinner from './Spinner'

/** Reads backwards until the last user question is found, including across pages. */
export async function loadArchivedExchange(projectId: string, sessionId: string, cancelled: () => boolean) {
  let messages: WorkflowGenHistoryMessage[] = []
  let offset = 0
  const limit = 50
  while (!cancelled()) {
    const page = await chatSessionApi.get(sessionId, projectId, limit, offset)
    if (cancelled()) return []
    messages = [...page.messages, ...messages]
    const questionIndex = messages.findLastIndex((message) => message.role === 'user')
    if (questionIndex >= 0) return messages.slice(questionIndex)
    if (page.messages.length < limit) return []
    offset += page.messages.length
  }
  return []
}

export default function ArchivedChatPreview({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<WorkflowGenHistoryMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setMessages([])
    void loadArchivedExchange(projectId, sessionId, () => cancelled).then((result) => {
      if (!cancelled) setMessages(result)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, sessionId, attempt])

  return <section className="archived-chat-preview" aria-label={t('chatSession.archivePreview')}>
    {loading ? <div role="status"><Spinner size={14} /> {t('common.loading')}</div>
      : error ? <div role="alert">{error} <Button onClick={() => setAttempt((value) => value + 1)}>{t('common.retry')}</Button></div>
      : messages.length === 0 ? <div>{t('chatSession.archiveNoQuestion')}</div>
      : <>
        {messages.map((message) => <ChatMessageBubble key={message.id}
          role={message.role} sender={t(message.role === 'user' ? 'chatSession.archiveQuestion' : 'chatSession.archiveReply')}
          initials={message.role === 'user' ? 'U' : 'AI'} color="var(--muted)"
          content={message.content} projectId={projectId} />)}
        {!messages.some((message) => message.role === 'assistant') && <div>{t('chatSession.archiveNoReply')}</div>}
      </>}
  </section>
}
