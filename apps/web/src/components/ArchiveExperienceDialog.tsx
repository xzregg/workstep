import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useTaskStore, type LiveMessage } from '../stores/taskStore'
import { randomUuid } from '../utils/uuid'
import ConfirmDialog from './ConfirmDialog'
import ArchiveExperienceProgress from './ArchiveExperienceProgress'
import MarkdownEditor from './MarkdownEditor'

type Phase = 'loading' | 'intro' | 'generating' | 'stopping' | 'stopped'
  | 'review' | 'empty' | 'saving' | 'archiving'

interface Props {
  task: { id: string; title: string }
  projectId?: string
  onClose: () => void
  onArchived: (taskId: string) => void
}

/** Owns the archive experience draft, generation lifecycle, and confirmation UI. */
export default function ArchiveExperienceDialog({ task, projectId, onClose, onArchived }: Props) {
  const { t } = useI18n()
  const getDraft = useTaskStore((state) => state.getArchiveExperienceDraft)
  const prepareDraft = useTaskStore((state) => state.prepareArchiveExperience)
  const stopDraftRequest = useTaskStore((state) => state.stopArchiveExperience)
  const confirmArchive = useTaskStore((state) => state.confirmArchiveExperience)
  const archiveDirectly = useTaskStore((state) => state.archiveTask)
  const [experience, setExperience] = useState('')
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<Phase>('loading')
  const [messageId, setMessageId] = useState<string | null>(null)
  const [historyMessage, setHistoryMessage] = useState<LiveMessage>()
  const stoppedIds = useRef(new Set<string>())
  const progressMessage = useTaskStore((state) => messageId
    ? state.liveMessages[task.id]?.[messageId] : undefined)
  const visibleProgressMessage = progressMessage || historyMessage

  useEffect(() => {
    let active = true
    setExperience('')
    setError('')
    setPhase('loading')
    setMessageId(null)
    setHistoryMessage(undefined)
    stoppedIds.current.clear()
    if (!projectId) {
      setPhase('intro')
      return () => { active = false }
    }
    void getDraft(task.id, projectId).then((draft) => {
      if (!active) return
      if (!draft.found) {
        setPhase('intro')
        return
      }
      setExperience(draft.experience)
      setMessageId(draft.message_id)
      setHistoryMessage({ id: draft.message_id || `archive-experience-${task.id}`,
        channel: 'archive_experience', content: draft.experience,
        events: draft.events, status: 'succeeded', prompt: draft.prompt, proposals: [] })
      setPhase(draft.has_experience ? 'review' : 'empty')
    }).catch(() => { if (active) setPhase('intro') })
    return () => { active = false }
  }, [task.id, projectId, getDraft])

  const stopDraft = async (closeAfterStop: boolean) => {
    if (!projectId || !messageId) return
    stoppedIds.current.add(messageId)
    setError('')
    setPhase('stopping')
    try {
      await stopDraftRequest(task.id, projectId, messageId)
    } catch (reason) {
      if (!closeAfterStop) setError(t('taskList.archiveExperienceStopFailed', {
        error: reason instanceof Error ? reason.message : t('common.unknownError'),
      }))
    } finally {
      if (closeAfterStop) onClose()
      else setPhase('stopped')
    }
  }

  const handleConfirm = async () => {
    if (!projectId || ['loading', 'stopping', 'saving', 'archiving'].includes(phase)) return
    if (phase === 'generating') {
      await stopDraft(false)
      return
    }
    if (phase === 'empty') {
      setError('')
      setPhase('archiving')
      try {
        await confirmArchive(task.id, projectId, '')
        onArchived(task.id)
      } catch (reason) {
        setError(t('taskList.archiveExperienceDirectArchiveFailed', {
          error: reason instanceof Error ? reason.message : t('common.unknownError'),
        }))
        setPhase('empty')
      }
      return
    }
    if (phase === 'intro' || phase === 'stopped') {
      setError('')
      setPhase('generating')
      const newMessageId = randomUuid()
      setMessageId(newMessageId)
      try {
        const draft = await prepareDraft(task.id, projectId, newMessageId)
        if (stoppedIds.current.has(newMessageId)) return
        setExperience(draft.experience)
        setPhase(draft.has_experience ? 'review' : 'empty')
      } catch (reason) {
        if (stoppedIds.current.has(newMessageId)) return
        setError(t('taskList.archiveExperienceGenerateFailed', {
          error: reason instanceof Error ? reason.message : t('common.unknownError'),
        }))
        setPhase('intro')
      }
      return
    }
    const reviewed = experience.trim()
    if (!reviewed) return
    setError('')
    setPhase('saving')
    try {
      await confirmArchive(task.id, projectId, reviewed)
      onArchived(task.id)
    } catch (reason) {
      setError(t('taskList.archiveExperienceSaveFailed', {
        error: reason instanceof Error ? reason.message : t('common.unknownError'),
      }))
      setPhase('review')
    }
  }

  const handleDirectArchive = async () => {
    if (!projectId || ['loading', 'stopping', 'saving', 'archiving'].includes(phase)) return
    const previous = phase
    let stoppedActiveDraft = previous === 'stopped'
    setError('')
    setPhase('archiving')
    try {
      if (previous === 'generating' && messageId) {
        stoppedIds.current.add(messageId)
        await stopDraftRequest(task.id, projectId, messageId)
        stoppedActiveDraft = true
      }
      await archiveDirectly(task.id, projectId)
      onArchived(task.id)
    } catch (reason) {
      setError(t('taskList.archiveExperienceDirectArchiveFailed', {
        error: reason instanceof Error ? reason.message : t('common.unknownError'),
      }))
      setPhase(previous === 'review' ? 'review' : stoppedActiveDraft ? 'stopped' : 'intro')
    }
  }

  const handleCancel = () => {
    if (phase === 'generating') { void stopDraft(true); return }
    if (phase !== 'saving' && phase !== 'archiving') onClose()
  }
  const showProgress = ['generating', 'stopping', 'stopped'].includes(phase)
    || (phase === 'archiving' && messageId !== null)

  return <ConfirmDialog open title={t('taskList.archiveTask')}
    message={phase === 'review' || phase === 'saving' ? t('taskList.archiveExperienceReviewMessage')
      : phase === 'empty' ? t('taskList.archiveExperienceEmptyMessage')
        : phase === 'loading' ? t('taskList.archiveExperienceLoadingDraft')
          : phase === 'archiving' ? t('taskList.archiveExperienceDirectArchivingMessage')
            : phase === 'generating' || phase === 'stopping' ? t('taskList.archiveExperienceProgressMessage')
              : phase === 'stopped' ? t('taskList.archiveExperienceStoppedMessage')
                : t('taskList.archiveExperienceIntroMessage', { title: task.title || t('taskList.thatTask') })}
    confirmText={phase === 'review' || phase === 'saving' ? t('taskList.archiveExperienceConfirm')
      : phase === 'empty' ? t('taskList.archiveExperienceDirectArchive')
        : phase === 'loading' ? t('common.loading')
          : phase === 'generating' || phase === 'stopping' ? t('taskList.archiveExperienceStop')
            : phase === 'stopped' ? t('taskList.archiveExperienceRetry')
              : t('taskList.archiveExperienceGenerate')}
    cancelText={phase === 'generating' || phase === 'stopping'
      ? t('taskList.archiveExperienceCancelAndClose') : undefined}
    secondaryText={phase === 'empty' || phase === 'loading'
      ? undefined : t('taskList.archiveExperienceDirectArchive')}
    secondaryLoading={phase === 'archiving'}
    secondaryDisabled={phase === 'stopping' || phase === 'saving'}
    loading={phase === 'loading' || phase === 'stopping' || phase === 'saving'}
    confirmDisabled={phase === 'loading' || phase === 'stopping' || phase === 'archiving'
      || ((phase === 'review' || phase === 'saving') && !experience.trim())}
    width={680} onConfirm={handleConfirm} onSecondary={handleDirectArchive} onCancel={handleCancel}>
    {showProgress && projectId && <div className="archive-experience-section">
      <ArchiveExperienceProgress message={visibleProgressMessage} projectId={projectId}
        running={phase === 'generating' || phase === 'stopping' || phase === 'archiving'}
        agentName={t('taskList.archiveExperienceAgent')}
        thinkingLabel={t('taskList.archiveExperienceThinking')} />
    </div>}
    {phase === 'empty' && projectId && <div className="archive-experience-section">
      <ArchiveExperienceProgress message={visibleProgressMessage}
        fallbackContent={t('taskList.archiveExperienceEmptyResult')} projectId={projectId}
        running={false} agentName={t('taskList.archiveExperienceAgent')}
        thinkingLabel={t('taskList.archiveExperienceThinking')} />
    </div>}
    {(phase === 'review' || phase === 'saving') && <div className="archive-experience-section">
      {visibleProgressMessage && <details className="archive-experience-process">
        <summary>{t('taskList.archiveExperienceViewProcess')}</summary>
        <ArchiveExperienceProgress message={visibleProgressMessage} projectId={projectId || ''}
          running={false} agentName={t('taskList.archiveExperienceAgent')}
          thinkingLabel={t('taskList.archiveExperienceThinking')} />
      </details>}
      <MarkdownEditor value={experience} onChange={setExperience}
        placeholder={t('taskList.archiveExperiencePlaceholder')}
        minHeight={220} maxHeight="42vh" maxLength={800}
        disabled={phase === 'saving'} autoFocus ariaLabel={t('taskList.archiveExperienceAria')} />
      <div className="archive-experience-length">
        {t('taskList.archiveExperienceLength', { count: experience.length })}
      </div>
    </div>}
    {error && <div className="archive-experience-error" role="alert">{error}</div>}
  </ConfirmDialog>
}
