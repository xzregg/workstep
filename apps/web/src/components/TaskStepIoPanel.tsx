import { useEffect, useMemo, useState } from 'react'
import type { TaskArtifact, TaskArtifactInputSnapshot } from '../api/client'
import { useI18n } from '../i18n'
import { toMilliseconds } from '../utils/datetime'
import {
  artifactsForStepRoundOutputs, downstreamInputsForOutput, findPreferredArtifact,
  findStepRoundInputArtifact, findStepRoundInputPort, groupStepOutputsByInput,
  hasStepIoContractChanged,
} from '../pages/taskArtifactRules'
import type { StepData, StepProgress, TaskDetailViewProps } from './TaskDetailView'
import ArtifactUnchangedBadge from './ArtifactUnchangedBadge'
import Button from './Button'
import Icon from './Icon'
import MarqueeText from './MarqueeText'
import TaskDetailTabs from './TaskDetailTabs'

interface TaskStepIoPanelProps {
  currentStep: StepData
  steps: StepData[]
  workflowConnections: NonNullable<TaskDetailViewProps['workflowConnections']>
  progress?: StepProgress
  artifacts: TaskArtifact[]
  artifactInputSnapshots: TaskArtifactInputSnapshot[]
  canChat: boolean
  restartingStepKeys?: string[]
  onRestartStepWithFreshSession?: (stepKey: string) => void
  onOpenArtifact: TaskDetailViewProps['onOpenArtifact']
  locale: string
}

function artifactKeyDown(event: React.KeyboardEvent, open: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open()
  }
}

export default function TaskStepIoPanel({ currentStep, steps, workflowConnections,
  progress, artifacts, artifactInputSnapshots, canChat, restartingStepKeys,
  onRestartStepWithFreshSession, onOpenArtifact, locale }: TaskStepIoPanelProps) {
  const { t } = useI18n()
  const rounds = useMemo(() => [...new Set(artifacts
    .filter((artifact) => artifact.step_key === currentStep.key && artifact.round)
    .map((artifact) => artifact.round))].sort((a, b) => a - b), [artifacts, currentStep.key])
  const unchangedFrom = useMemo(() => new Map(artifacts
    .filter((artifact) => artifact.step_key === currentStep.key && artifact.round_unchanged_from)
    .map((artifact) => [artifact.round, artifact.round_unchanged_from!])), [artifacts, currentStep.key])
  const [selectedRound, setSelectedRound] = useState<number | null>(null)
  useEffect(() => setSelectedRound(null), [currentStep.key])
  const activeRound = selectedRound && rounds.includes(selectedRound)
    ? selectedRound : rounds[rounds.length - 1]
  const executionRound = activeRound ?? progress?.artifact_round ?? undefined
  const restarting = (restartingStepKeys ?? []).includes(currentStep.key)
  const canRerun = canChat && Boolean(onRestartStepWithFreshSession)
    && Boolean(progress?.has_history)
    && hasStepIoContractChanged(currentStep, progress?.io_contract)
    && !['running', 'reviewing', 'retrying', 'rework', 'rework_waiting'].includes(progress?.status ?? '')
  const dateText = (value?: string | null) => {
    const milliseconds = toMilliseconds(value)
    return milliseconds === null ? '' : new Date(milliseconds).toLocaleString(locale, {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  }
  const producedOutputs = artifactsForStepRoundOutputs(artifacts, currentStep.key, activeRound)
  const outputsByInput = groupStepOutputsByInput(
    currentStep.inputs || [], currentStep.outputs || [], producedOutputs,
  )

  return <section className="task-step-io">
    <div className="task-step-io-header">
      <strong>{t('taskDetail.stepIo')}</strong>
      <div className="task-step-io-actions">
        {canRerun && <Button size="sm" loading={restarting} disabled={restarting}
          onClick={() => onRestartStepWithFreshSession?.(currentStep.key)}>
          {restarting ? t('taskDetail.rerunningLatestWorkflow') : t('taskDetail.rerunLatestWorkflow')}
        </Button>}
        {rounds.length > 0 && <TaskDetailTabs className="task-step-round-tabs"
          ariaLabel={t('taskDetail.artifactRoundTabsAria')} selected={activeRound!}
          onSelect={setSelectedRound} tabs={rounds.map((round) => ({ id: round,
            label: <><span>{t('taskDetail.artifactRoundTab', { round })}</span>
              {unchangedFrom.get(round) && <ArtifactUnchangedBadge fromRound={unchangedFrom.get(round)!} />}
            </>,
          }))} />}
      </div>
    </div>
    <div className="task-step-io-inputs">
      <div className="task-step-io-label"><span aria-hidden="true">→</span>{t('taskDetail.ioInput')}</div>
      {(currentStep.inputs || []).map((input, inputIndex) => {
        const subOutputs = outputsByInput[inputIndex] || []
        const snapshot = findStepRoundInputPort(artifactInputSnapshots, currentStep.key, executionRound, inputIndex)
        const snapshotArtifact = findStepRoundInputArtifact(
          artifacts, artifactInputSnapshots, currentStep.key, executionRound, inputIndex,
        )
        const inputArtifact = snapshotArtifact
          ?? (snapshot ? undefined : findPreferredArtifact(artifacts, input.name))
        const taskContext = snapshot?.status === 'task_context'
        const inputStatus = inputArtifact ? t('taskDetail.inputReady')
          : taskContext ? t('taskDetail.inputTaskContext')
            : snapshot?.status === 'inactive' ? t('taskDetail.inputInactive')
              : t('taskDetail.inputUnavailable')
        const inputUpdatedAt = dateText(inputArtifact?.updated_at)
        const openInput = () => inputArtifact && onOpenArtifact(
          inputArtifact.name, inputArtifact.step_key, inputArtifact.round, inputArtifact.path,
        )
        return <div className="task-step-io-group" key={inputIndex}>
          <div className="task-step-io-input" data-openable={Boolean(inputArtifact)}
            role={inputArtifact ? 'button' : undefined} tabIndex={inputArtifact ? 0 : undefined}
            aria-label={inputArtifact ? t('taskDetail.openInputAria', { name: input.name }) : undefined}
            title={inputArtifact ? t('taskDetail.openFileTitle', { name: input.name }) : undefined}
            onClick={inputArtifact ? openInput : undefined}
            onKeyDown={inputArtifact ? (event) => artifactKeyDown(event, openInput) : undefined}>
            {inputUpdatedAt && <span className="task-step-io-date"
              title={t('taskDetail.artifactModifiedAt', { time: inputUpdatedAt })}>{inputUpdatedAt}</span>}
            <span className="task-step-io-dot task-step-io-dot--input" />
            <span className="task-step-io-identity">
              <span className="task-step-io-name">{input.name}</span>
              <span className="task-step-io-type">{input.type}</span>
            </span>
            {inputArtifact?.round ? <span className="task-step-io-round">
              {t('taskDetail.artifactRound', { round: inputArtifact.round })}</span> : null}
            {inputArtifact?.unchanged_from_round &&
              <ArtifactUnchangedBadge fromRound={inputArtifact.unchanged_from_round} />}
            <span className="task-step-io-status" data-ready={Boolean(inputArtifact || taskContext)}>{inputStatus}</span>
            {inputArtifact && <span className="task-step-io-open">{t('taskDetail.view')}</span>}
          </div>
          {subOutputs.map((output: any, outputIndex: number) => {
            const downstream = downstreamInputsForOutput(
              steps, workflowConnections, currentStep.key, output.outputIndex,
            )
            const routeLabels = downstream.map((target) => `→ ${target.stepLabel}: ${target.inputName}`)
            const outputArtifact = output.artifact ?? findPreferredArtifact(
              artifacts, output.name, currentStep.key, activeRound,
            )
            const outputUpdatedAt = dateText(outputArtifact?.updated_at)
            const outputReady = Boolean(outputArtifact)
            const openOutput = () => onOpenArtifact(
              outputArtifact?.name ?? output.name, currentStep.key, activeRound, outputArtifact?.path,
            )
            return <div className="task-step-io-output" data-openable={outputReady}
              key={outputIndex} role={outputReady ? 'button' : undefined}
              tabIndex={outputReady ? 0 : undefined}
              aria-label={outputReady ? t('taskDetail.openOutputAria', { name: output.name }) : undefined}
              title={outputReady ? t('taskDetail.openFileTitle', { name: output.name }) : undefined}
              onClick={outputReady ? openOutput : undefined}
              onKeyDown={outputReady ? (event) => artifactKeyDown(event, openOutput) : undefined}>
              <span className="task-step-io-branch" aria-hidden="true">↳</span>
              {outputUpdatedAt && <span className="task-step-io-date"
                title={t('taskDetail.artifactModifiedAt', { time: outputUpdatedAt })}>{outputUpdatedAt}</span>}
              {outputArtifact?.is_dir ? <Icon name="folder" size={13} color="var(--accent)" />
                : <span className="task-step-io-dot" data-ready={outputReady} />}
              <span className="task-step-io-output-identity">
                <span className="task-step-io-name">{output.name}</span>
                <span className="task-step-io-type">{output.type}</span>
              </span>
              {downstream.length > 0 && <MarqueeText className="step-output-route-marquee"
                text={routeLabels.join('   ')} title={routeLabels.join('\n')} />}
              <span className="task-step-io-spacer" aria-hidden="true" />
              {outputArtifact?.round ? <span className="task-step-io-round">
                {t('taskDetail.artifactRound', { round: outputArtifact.round })}</span> : null}
              {outputArtifact?.unchanged_from_round &&
                <ArtifactUnchangedBadge fromRound={outputArtifact.unchanged_from_round} />}
              <span className="task-step-io-status">
                {outputReady ? t('taskDetail.outputDone') : t('taskDetail.outputPending')}
              </span>
              {outputReady && <span className="task-step-io-open">{t('common.open')}</span>}
            </div>
          })}
        </div>
      })}
    </div>
  </section>
}
