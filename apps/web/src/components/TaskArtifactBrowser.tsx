import { useMemo, useState } from 'react'
import type { TaskArtifact } from '../api/client'
import { useI18n } from '../i18n'
import Icon from './Icon'

interface ArtifactStageDefinition {
  key: string
  label: string
  color?: string
}

export interface ArtifactRoundGroup {
  round: number
  artifacts: TaskArtifact[]
}

export interface ArtifactStageGroup extends ArtifactStageDefinition {
  rounds: ArtifactRoundGroup[]
  artifactCount: number
}

export function buildArtifactStageGroups(
  artifacts: TaskArtifact[],
  stages: ArtifactStageDefinition[],
): ArtifactStageGroup[] {
  const stageDefinitions = new Map(stages.map((stage, index) => [stage.key, { ...stage, index }]))
  const grouped = new Map<string, Map<number, TaskArtifact[]>>()

  artifacts.forEach((artifact) => {
    const stageRounds = grouped.get(artifact.step_key) || new Map<number, TaskArtifact[]>()
    const round = artifact.round || 1
    const roundArtifacts = stageRounds.get(round) || []
    roundArtifacts.push(artifact)
    stageRounds.set(round, roundArtifacts)
    grouped.set(artifact.step_key, stageRounds)
  })

  return [...grouped.entries()]
    .map(([key, rounds]) => {
      const definition = stageDefinitions.get(key)
      const sortedRounds = [...rounds.entries()]
        .sort(([left], [right]) => left - right)
        .map(([round, roundArtifacts]) => ({ round, artifacts: roundArtifacts }))
      return {
        key,
        label: definition?.label || key,
        color: definition?.color,
        rounds: sortedRounds,
        artifactCount: sortedRounds.reduce((count, item) => count + item.artifacts.length, 0),
        order: definition?.index ?? Number.MAX_SAFE_INTEGER,
      }
    })
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
    .map(({ order: _order, ...group }) => group)
}

export function resolveArtifactRound(rounds: number[], selectedRound: number | null) {
  if (selectedRound !== null && rounds.includes(selectedRound)) return selectedRound
  return rounds[rounds.length - 1] ?? null
}

export function artifactFileType(artifact: Pick<TaskArtifact, 'name' | 'path' | 'is_dir' | 'artifact_type'>) {
  if (artifact.is_dir) return ''
  const filename = artifact.name || artifact.path.split(/[\\/]/).pop() || ''
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex > 0 && dotIndex < filename.length - 1) return filename.slice(dotIndex + 1).toLowerCase()
  return artifact.artifact_type || ''
}

function latestUpdatedAt(artifacts: TaskArtifact[]) {
  return artifacts.reduce<string | null>((latest, artifact) => {
    if (!artifact.updated_at) return latest
    if (!latest) return artifact.updated_at
    return new Date(artifact.updated_at).getTime() > new Date(latest).getTime()
      ? artifact.updated_at
      : latest
  }, null)
}

export default function TaskArtifactBrowser({
  artifacts,
  stages,
  onOpenArtifact,
}: {
  artifacts: TaskArtifact[]
  stages: ArtifactStageDefinition[]
  onOpenArtifact: (name: string, stepKey?: string, round?: number) => void
}) {
  const { t, locale } = useI18n()
  const stageGroups = useMemo(
    () => buildArtifactStageGroups(artifacts, stages),
    [artifacts, stages],
  )
  const [selectedRounds, setSelectedRounds] = useState<Record<string, number>>({})

  if (!stageGroups.length) {
    return <div className="task-detail-artifacts task-artifact-browser-empty">{t('mobile.noArtifacts')}</div>
  }

  return (
    <div className="task-detail-artifacts">
      <div className="task-artifact-browser">
        {stageGroups.map((stage) => {
          const activeRoundNumber = resolveArtifactRound(
            stage.rounds.map((item) => item.round),
            selectedRounds[stage.key] ?? null,
          )
          const activeRound = stage.rounds.find((item) => item.round === activeRoundNumber)
          if (!activeRound) return null
          const updatedAt = latestUpdatedAt(activeRound.artifacts)
          const updatedAtLabel = updatedAt
            ? new Date(updatedAt).toLocaleString(locale, {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })
            : ''

          return (
            <section key={stage.key} className="task-artifact-stage-section">
              <div className="task-artifact-stage-heading">
                <strong>
                  <span className="task-artifact-stage-dot" style={{ background: stage.color || 'var(--accent)' }} />
                  {stage.label}
                </strong>
                <span>{t('taskDetail.artifactStageSummary', {
                  rounds: stage.rounds.length,
                  count: stage.artifactCount,
                })}</span>
              </div>

              <div className="task-artifact-round-tabs" role="tablist" aria-label={`${stage.label} ${t('taskDetail.artifactRoundTabsAria')}`}>
                {stage.rounds.map((round) => (
                  <button
                    key={round.round}
                    type="button"
                    role="tab"
                    aria-selected={round.round === activeRoundNumber}
                    onClick={() => setSelectedRounds((current) => ({
                      ...current,
                      [stage.key]: round.round,
                    }))}
                  >
                    <span className="task-artifact-round-tab-label">
                      {t('taskDetail.artifactRound', { round: round.round })}
                    </span>
                  </button>
                ))}
              </div>

              <div className="task-artifact-round-heading">
                <span>{t('taskDetail.artifactRoundSummary', {
                  round: activeRound.round,
                  count: activeRound.artifacts.length,
                })}</span>
                {updatedAtLabel && <time dateTime={updatedAt || undefined}>{updatedAtLabel}</time>}
              </div>

              <div className="task-artifact-file-list">
                {activeRound.artifacts.map((artifact) => {
                  const fileType = artifactFileType(artifact)
                  return (
                    <button
                      key={`${artifact.step_key}:${artifact.round}:${artifact.path}`}
                      type="button"
                      className="task-artifact-file-row"
                      onClick={() => onOpenArtifact(artifact.name, artifact.step_key, artifact.round)}
                      aria-label={t('taskDetail.openOutputAria', { name: artifact.logical_name || artifact.name })}
                    >
                      <span className="task-artifact-file-main">
                        <Icon name={artifact.is_dir ? 'folder' : 'file'} size={16} />
                        <span className="task-artifact-file-name">{artifact.logical_name || artifact.name}</span>
                        {fileType && <span className="task-artifact-file-type">{fileType}</span>}
                      </span>
                      <span className="task-artifact-file-status">{t('taskDetail.outputDone')}</span>
                      <span className="task-artifact-file-open">{t('common.open')}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
