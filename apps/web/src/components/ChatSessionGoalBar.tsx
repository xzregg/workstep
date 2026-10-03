import { useState } from 'react'
import { useI18n } from '../i18n'
import type { GoalSnapshot } from '../utils/goal'
import Button from './Button'
import Spinner from './Spinner'
import PromptViewerDialog from './PromptViewerDialog'
import Icon from './Icon'
import { useCompactLayout } from '../hooks/useCompactLayout'
import './ChatSessionGoalBar.css'

interface Props {
  projectId?: string
  goal: GoalSnapshot | null
  running: boolean
  stopping: boolean
  onResume: () => Promise<boolean>
  onEnd: () => Promise<boolean>
}

/** Conversation goal controls stay visible above the composer, also on mobile. */
export default function ChatSessionGoalBar({ projectId, goal, running, stopping, onResume, onEnd }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const [pending, setPending] = useState<'resume' | 'end' | null>(null)
  const [originalOpen, setOriginalOpen] = useState(false)
  if (!goal || goal.status === 'cleared') return null
  const finished = goal.status === 'complete'
  const busy = pending !== null || stopping
  const act = async (action: 'resume' | 'end') => {
    if (busy) return
    setPending(action)
    try {
      await (action === 'resume' ? onResume() : onEnd())
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <section className="chat-session-goal-bar" aria-label={t('goal.title')}>
        <div className="chat-session-goal-summary">
          <span className="chat-session-goal-status">
            {running && <span className="chat-session-goal-spinner"><Spinner size={12} /></span>}
            {t(`goal.status.${goal.status}` as Parameters<typeof t>[0])}
          </span>
          <span className="chat-session-goal-objective" title={goal.objective}>{goal.objective}</span>
        </div>
        <div className="chat-session-goal-actions">
          <Button size="sm" className="chat-session-goal-action" data-goal-action="original" disabled={!goal.objective}
            title={t('goal.original')} aria-label={t('goal.original')}
            onClick={() => setOriginalOpen(true)}>
            <Icon name="file" size={16} />
            {!compact && t('goal.original')}
          </Button>
          {!finished && <>
            <Button size="sm" className="chat-session-goal-action" data-goal-action="resume" disabled={running || busy}
              title={t('goal.resume')} aria-label={t('goal.resume')}
              loading={pending === 'resume'} onClick={() => void act('resume')}>
              {pending !== 'resume' && <Icon name="rotate-ccw" size={16} />}
              {!compact && t('goal.resume')}
            </Button>
            <Button size="sm" className="chat-session-goal-action" data-goal-action="end" disabled={busy}
              title={t('goal.end')} aria-label={t('goal.end')}
              loading={pending === 'end'} onClick={() => void act('end')}>
              {pending !== 'end' && <Icon name="stop" size={16} fill />}
              {!compact && t('goal.end')}
            </Button>
          </>}
        </div>
      </section>
      {originalOpen && <PromptViewerDialog
        prompt={goal.objective} projectId={projectId} title={t('goal.original')}
        onClose={() => setOriginalOpen(false)}
      />}
    </>
  )
}
