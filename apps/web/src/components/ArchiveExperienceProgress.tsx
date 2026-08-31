import { useEffect, useState } from 'react'
import type { LiveMessage } from '../stores/taskStore'
import { useI18n } from '../i18n'
import { formatDuration } from '../utils/datetime'
import ChatMessageBubble from './ChatMessageBubble'
import MessageMetaBar from './MessageMetaBar'
import PromptViewerDialog from './PromptViewerDialog'
import StreamingStatusText from './StreamingStatusText'

interface Props {
  message?: LiveMessage
  fallbackContent?: string
  projectId: string
  running: boolean
  agentName: string
  thinkingLabel: string
}

/** Read-only coordinator process view used while distilling archive mistakes. */
export default function ArchiveExperienceProgress({
  message,
  fallbackContent,
  projectId,
  running,
  agentName,
  thinkingLabel,
}: Props) {
  const { t } = useI18n()
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (!running) {
      setElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const updateElapsed = () => setElapsedMs(Date.now() - startedAt)
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [message?.id, running])

  const activeLabel = elapsedMs >= 1000
    ? `${thinkingLabel} · ${formatDuration(elapsedMs, t)}`
    : thinkingLabel

  return (
    <>
      <div
        aria-live="polite"
        aria-label={thinkingLabel}
        style={{
          minHeight: 220,
          maxHeight: '42vh',
          overflowY: 'auto',
          padding: '14px 12px',
          border: '1px solid var(--border-soft)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg)',
        }}
      >
        <ChatMessageBubble
          role="assistant"
          sender={agentName}
          initials="协"
          color="var(--ai-assistant)"
          content={message?.content || fallbackContent || ''}
          events={message?.events || []}
          streaming={running}
          projectId={projectId}
          showLoading
          loading={<StreamingStatusText label={activeLabel} />}
          variant="bg"
          header={(
            <MessageMetaBar
              createdAt={message?.created_at}
              running={running}
              events={message?.events || []}
              prompt={message?.prompt}
              status={message?.status === 'failed'
                ? 'failed'
                : message?.status === 'stopped'
                  ? 'stopped'
                  : undefined}
              onViewPrompt={setViewingPrompt}
            />
          )}
        />
      </div>
      {viewingPrompt && (
        <PromptViewerDialog
          prompt={viewingPrompt}
          projectId={projectId}
          zIndex={2100}
          onClose={() => setViewingPrompt(null)}
        />
      )}
    </>
  )
}
