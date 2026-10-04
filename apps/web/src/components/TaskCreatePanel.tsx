import React, { useCallback, useRef, useState } from 'react'
import type { Project } from '../api/client'
import { useTaskStore } from '../stores/taskStore'
import type { TaskDraftResult } from '../stores/taskDraftStore'
import { useOnboardingStore } from '../stores/onboardingStore'
import { useI18n } from '../i18n'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { resolveTaskCreationErrors } from '../utils/taskCreationErrors.js'
import { localDateTimeAfter, localDateTimeToIso } from '../utils/scheduledStart'
import { assistantStarterPrompt, backfillEmptyTitle } from '../utils/assistantTitle'
import type { TaskLane } from '../pages/taskListLane'
import Button from './Button'
import Icon from './Icon'
import ConfirmDialog from './ConfirmDialog'
import Field from './Field'
import Input from './Input'
import DateTimePicker from './DateTimePicker'
import MarkdownEditor from './MarkdownEditor'
import AiTaskCreateChat from './AiTaskCreateChat'
import ReviewOverridesEditor from './ReviewOverridesEditor'

type ReviewOverride = { mode: 'skip' | 'auto' | 'manual'; auto: boolean; prompt: string; maxRetries: number }
interface Props {
  project: Project
  workflowId: string | null
  lanes: TaskLane[]
  initialStepKey?: string
  onClose: () => void
}

function initialReviewOverrides(steps: Project['steps']): Record<string, ReviewOverride> {
  const configs: Record<string, ReviewOverride> = {}
  for (const node of steps?.nodes || []) {
    const key = (node.type || node.key || String(node.id)) as string
    const review = node.review || {}
    configs[key] = {
      mode: ['skip', 'auto', 'manual'].includes(review.mode) ? review.mode : review.auto ? 'auto' : 'manual',
      auto: !!review.auto,
      prompt: String(review.prompt || ''),
      maxRetries: Math.max(1, Math.min(5, Number(review.maxRetries) || 1)),
    }
  }
  return configs
}

/** Owns the task creation form, AI draft, review settings, and discard confirmation. */
export default function TaskCreatePanel({ project, workflowId, lanes, initialStepKey, onClose }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const createTask = useTaskStore((state) => state.createTask)
  const selectedStepKey = initialStepKey || lanes[0]?.key || null
  const selectedStep = [...(project.steps?.nodes || []), ...(project.steps?.steps || [])]
    .find((step: any) => (step.type || step.key || String(step.id)) === selectedStepKey)
  const initialAutoStart = Boolean(selectedStep?.autoStart)
  const initialOverrides = useRef(initialReviewOverrides(project.steps)).current
  const [createStartStepKey, setCreateStartStepKey] = useState<string | null>(selectedStepKey)
  const createLane = lanes.find((lane) => lane.key === createStartStepKey) || lanes[0]
  const createLaneIndex = Math.max(0, lanes.findIndex((lane) => lane.key === createLane?.key))
  const [reviewOverrides, setReviewOverrides] = useState<Record<string, ReviewOverride>>(initialOverrides)
  const [newTitle, setNewTitle] = useState('')
  const [createError, setCreateError] = useState('')
  const [activeTab, setActiveTab] = useState<'content' | 'review' | 'assistant'>(compact ? 'assistant' : 'content')
  const [newDesc, setNewDesc] = useState('')
  const [newAutoStart, setNewAutoStart] = useState(initialAutoStart)
  const [newStartMode, setNewStartMode] = useState<'manual' | 'immediate' | 'scheduled'>(initialAutoStart ? 'immediate' : 'manual')
  const [newScheduledStart, setNewScheduledStart] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirmCloseNewTask, setConfirmCloseNewTask] = useState(false)
  const [taskAiOpen, setTaskAiOpen] = useState(true)
  const [taskAiBusy, setTaskAiBusy] = useState(false)
  const [taskAiMessage, setTaskAiMessage] = useState('')
  const [taskAiChatWidth, setTaskAiChatWidth] = useState<number | null>(null)
  const [pendingTaskDraft, setPendingTaskDraft] = useState<TaskDraftResult | null>(null)
  const newTitleInputRef = useRef<HTMLInputElement>(null)
  const newPanelRef = useRef<HTMLDivElement>(null)
  const newPanelBaselineRef = useRef({
    title: '', desc: '', autoStart: initialAutoStart,
    startMode: initialAutoStart ? 'immediate' : 'manual',
    scheduledStart: '', startStepKey: selectedStepKey,
    overrides: initialOverrides,
  })
  const taskCreationErrors = resolveTaskCreationErrors('', createError)

  const handleCreate = async () => {
    if (!newTitle.trim() || taskAiBusy || creating
      || (newStartMode === 'scheduled' && !localDateTimeToIso(newScheduledStart))) return
    setCreating(true)
    try {
      const task = await createTask(
        newTitle.trim(),
        project.path,
        project.id,
        newDesc.trim() || undefined,
        createLane?.key,
        Object.keys(reviewOverrides).length > 0 ? reviewOverrides : undefined,
        workflowId,
        newStartMode === 'immediate',
        newStartMode === 'scheduled' ? localDateTimeToIso(newScheduledStart) : null,
      )
      const onboarding = useOnboardingStore.getState()
      if (
        onboarding.status === 'active'
        && onboarding.currentStep === 'task'
        && onboarding.workflowId === workflowId
      ) {
        onboarding.recordTask(task.id)
      }
      onClose()
    } catch (e: any) {
      setCreateError(e?.message || t('taskList.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  const requestCloseTaskAi = () => {
    if (compact) setActiveTab('content')
    if (taskAiBusy) {
      setConfirmCloseNewTask(true)
      return
    }
    setTaskAiOpen(false)
  }

  const handleStartTaskAi = () => {
    if (taskAiOpen) {
      requestCloseTaskAi()
      return
    }
    setCreateError('')
    setTaskAiMessage(assistantStarterPrompt(
      newTitle,
      (name) => t('taskList.aiCreatePrompt', { name }),
    ))
    setTaskAiOpen(true)
    setActiveTab(compact ? 'assistant' : 'content')
  }

  const applyTaskDraft = useCallback((draft: TaskDraftResult) => {
    const targetLane = lanes.find((lane) => lane.key === draft.start_step_key)
    if (!targetLane) {
      setCreateError(t('taskList.aiGenerateFailed'))
      return
    }
    setNewTitle((current) => backfillEmptyTitle(current, draft.title))
    setNewDesc(draft.description)
    setCreateStartStepKey(targetLane.key)
    setPendingTaskDraft(null)
  }, [lanes, t])

  const handleTaskDraft = useCallback((draft: TaskDraftResult) => {
    if (newDesc.trim()) {
      setPendingTaskDraft(draft)
      return
    }
    applyTaskDraft(draft)
  }, [applyTaskDraft, newDesc])

  const startTaskAiDividerDrag = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const panelWidth = Math.min(1100, window.innerWidth * 0.9)
    const startWidth = taskAiChatWidth ?? Math.round((panelWidth * 2) / 5)
    const onMove = (moveEvent: MouseEvent) => {
      setTaskAiChatWidth(Math.max(280, Math.min(panelWidth - 320, startWidth + (startX - moveEvent.clientX))))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const closeNewPanel = () => {
    if (creating) return
    const baseline = newPanelBaselineRef.current
    const dirty = newTitle !== baseline.title
      || newDesc !== baseline.desc
      || newAutoStart !== baseline.autoStart
      || newStartMode !== baseline.startMode
      || newScheduledStart !== baseline.scheduledStart
      || createStartStepKey !== baseline.startStepKey
      || JSON.stringify(reviewOverrides) !== JSON.stringify(baseline.overrides)
    if (dirty || taskAiBusy) {
      setConfirmCloseNewTask(true)
    } else {
      onClose()
    }
  }

  useOverlay(compact, closeNewPanel, newPanelRef)

  return (
    <>
      {/* Backdrop: click outside closes the new-task panel when unchanged */}
      <div className="task-create-backdrop" onClick={closeNewPanel} />

      {/* ── New requirement panel (slide-in from right, fixed to viewport) ── */}
      <div ref={newPanelRef} role="dialog" aria-modal="true" aria-label={t('taskList.new')}
        className="task-create-panel" data-tab={activeTab} data-assistant-open={taskAiOpen}>
        <div className="panel-header">
          <span className="task-create-heading">{t('taskList.newTaskTitle', { lane: createLane?.label || t('taskList.requirement') })}</span>
          <Button variant="icon" onClick={closeNewPanel} aria-label={t('common.close')}>✕</Button>
        </div>
        <div className="task-create-body">
        <div className="task-create-form">
        {/* ── Tab bar ── */}
        <div className="task-create-tabs" role="tablist">
          <button
            role="tab"
            onClick={() => setActiveTab('content')}
            className="task-create-tab" aria-selected={activeTab === 'content'}
          >{t('taskList.contentTab')}</button>
          <button
            role="tab"
            onClick={() => setActiveTab('review')}
            className="task-create-tab" aria-selected={activeTab === 'review'}
          >{t('taskList.reviewTab')}</button>
          {compact && <button className="mobile-assistant-tab" aria-pressed={activeTab === 'assistant'} onClick={() => { setTaskAiOpen(true); setActiveTab('assistant') }}>{t('mobile.aiAssistant')}</button>}
        </div>

        {/* ── Tab: content ── */}
        {(activeTab === 'content' || (!compact && activeTab === 'assistant')) && (
        <div className="task-create-content">
          {createLaneIndex > 0 && (
            <div className="task-create-start-step"
              style={{ '--task-create-step-color': createLane?.color || 'var(--accent)' } as React.CSSProperties}>
              {t('taskList.startAtStep', { label: createLane?.label })}
              <br />
              {t('taskList.skipPrevious', {
                steps: lanes.slice(0, createLaneIndex)
                  .map((lane) => t('taskList.stepQuote', { label: lane.label }))
                  .join(t('taskList.joinList')),
              })}
            </div>
          )}
          <Field
            label={t('taskList.taskTitle')}
            htmlFor="new-task-title"
            error={taskCreationErrors.titleError || undefined}
          >
            <div className="task-create-title-row">
              <Input
                id="new-task-title"
                ref={newTitleInputRef}
                value={newTitle}
                onChange={(e) => {
                  setNewTitle(e.target.value)
                  setCreateError('')
                }}
                placeholder={t('taskList.titlePlaceholder')}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                className="task-create-title-input"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStartTaskAi}
                aria-expanded={taskAiOpen}
                title={t('taskList.aiCreateTitle')}
                className="task-create-ai-button"
              >
                <Icon name="sparkles" size={13} className="task-create-ai-icon" />
                {t('taskList.aiCreate')}
              </Button>
            </div>
          </Field>
          <label className="task-create-description-label">{t('taskList.taskDescription')}</label>
          <MarkdownEditor
            value={newDesc}
            onChange={setNewDesc}
            projectId={project?.id}
            placeholder={t('taskList.descPlaceholder', { lane: createLane?.label || t('taskList.currentStep') })}
            minHeight={102}
            showAttachmentHint
          />
          <div className="task-create-start-options" data-scheduled={newStartMode === 'scheduled'}>
            <Field label={t('taskList.startMode')}>
              <div className="task-create-start-modes">
                {([
                  ['manual', t('taskList.startModeManual')],
                  ['immediate', t('taskList.startModeImmediate')],
                  ['scheduled', t('taskList.startModeScheduled')],
                ] as const).map(([mode, label]) => (
                  <label key={mode} className="task-create-start-mode">
                    <input
                      type="radio"
                      name="new-task-start-mode"
                      value={mode}
                      checked={newStartMode === mode}
                      onChange={() => {
                        setNewStartMode(mode)
                        setNewAutoStart(mode === 'immediate')
                        if (mode !== 'scheduled') setNewScheduledStart('')
                      }}
                      className="task-create-start-radio"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Field>
            {newStartMode === 'scheduled' && (
              <Field label={t('taskList.scheduledStart')}>
                <DateTimePicker
                  value={newScheduledStart}
                  min={localDateTimeAfter(1)}
                  onChange={setNewScheduledStart}
                />
              </Field>
            )}
          </div>
        </div>
        )}

        {/* ── Tab: review ── */}
        {activeTab === 'review' && (
        <div className="task-create-review">
          <ReviewOverridesEditor value={reviewOverrides} onChange={setReviewOverrides} lanes={lanes} startStepKey={createLane?.key} projectId={project?.id} />
        </div>
        )}

        {/* ── Error & Footer ── */}
        {taskCreationErrors.panelError && (
          <div className="task-create-error">{taskCreationErrors.panelError}</div>
        )}
        <div className="task-create-footer">
          <Button
            variant="primary"
            className="task-create-primary"
            disabled={!newTitle.trim() || taskAiBusy || creating || (newStartMode === 'scheduled' && !localDateTimeToIso(newScheduledStart))}
            onClick={handleCreate}
          >
            <Icon name="plus" size={16} />
            {t('taskList.createTask')}
          </Button>
          <div className="task-create-secondary-row">
            <button
              type="button"
              className="task-create-assistant-status"
              aria-pressed={taskAiOpen}
              onClick={handleStartTaskAi}
            >
              <Icon name="sparkles" size={14} />
              {taskAiOpen ? t('taskList.assistantExpanded') : t('taskList.assistantCollapsed')}
            </button>
            <Button variant="ghost" className="task-create-cancel" onClick={closeNewPanel}>{t('common.cancel')}</Button>
          </div>
        </div>
        </div>
        {taskAiOpen && project && (
          <>
            <div
              className="task-create-divider"
              onMouseDown={startTaskAiDividerDrag}
              title={t('layout.dragResizeChat')}
            >
              <div className="task-create-divider-line" />
            </div>
            <div className="task-create-assistant"
              style={taskAiChatWidth === null ? undefined : { width: taskAiChatWidth }}>
              <AiTaskCreateChat
                projectId={project.id}
                taskTitle={newTitle.trim()}
                taskDescription={newDesc}
                allowGenerateTitle={!newTitle.trim()}
                workflowId={workflowId || undefined}
                startStepKey={createLane?.key}
                initialMessage={taskAiMessage}
                onDraft={handleTaskDraft}
                onBusyChange={setTaskAiBusy}
                onClose={requestCloseTaskAi}
              />
            </div>
          </>
        )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmCloseNewTask}
        title={t('taskList.discardNewTitle')}
        message={taskAiBusy ? t('taskList.aiRunningCloseMessage') : t('taskList.discardNewMessage')}
        confirmText={t('taskList.discard')}
        danger
        onConfirm={() => {
          setConfirmCloseNewTask(false)
          onClose()
        }}
        onCancel={() => setConfirmCloseNewTask(false)}
      />

      <ConfirmDialog
        open={pendingTaskDraft !== null}
        title={t('taskList.aiOverwriteTitle')}
        message={t('taskList.aiOverwriteMessage', {
          step: lanes.find((lane) => lane.key === pendingTaskDraft?.start_step_key)?.label
            || pendingTaskDraft?.start_step_key
            || t('taskList.currentStep'),
        })}
        confirmText={t('taskList.aiApply')}
        onConfirm={() => {
          if (pendingTaskDraft) applyTaskDraft(pendingTaskDraft)
        }}
        onCancel={() => setPendingTaskDraft(null)}
      />

    </>
  )
}
