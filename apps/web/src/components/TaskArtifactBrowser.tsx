import { useMemo, useState } from 'react'
import type { TaskArtifact } from '../api/client'
import { useI18n } from '../i18n'
import Icon from './Icon'
import MarqueeText from './MarqueeText'
import ProjectDirectoryBrowserDialog from './ProjectDirectoryBrowserDialog'
import TaskArtifactPreviewDialog from './TaskArtifactPreviewDialog'
import { collapseDirectoryArtifactChildren } from '../utils/artifactListing'
import ArtifactUnchangedBadge from './ArtifactUnchangedBadge'

interface ArtifactStepDefinition {
  key: string
  label: string
  color?: string
}

export interface ArtifactRoundGroup {
  round: number
  artifacts: TaskArtifact[]
}

export interface ArtifactStepGroup extends ArtifactStepDefinition {
  rounds: ArtifactRoundGroup[]
  artifactCount: number
}

export function buildArtifactStepGroups(
  artifacts: TaskArtifact[],
  steps: ArtifactStepDefinition[],
): ArtifactStepGroup[] {
  const stepDefinitions = new Map(steps.map((step, index) => [step.key, { ...step, index }]))
  const grouped = new Map<string, Map<number, TaskArtifact[]>>()

  collapseDirectoryArtifactChildren(artifacts).forEach((artifact) => {
    const stepRounds = grouped.get(artifact.step_key) || new Map<number, TaskArtifact[]>()
    const round = artifact.round || 1
    const roundArtifacts = stepRounds.get(round) || []
    roundArtifacts.push(artifact)
    stepRounds.set(round, roundArtifacts)
    grouped.set(artifact.step_key, stepRounds)
  })

  return [...grouped.entries()]
    .map(([key, rounds]) => {
      const definition = stepDefinitions.get(key)
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

function parentDirectory(path: string) {
  const parent = path.replace(/[\\/][^\\/]+$/, '')
  return parent === path ? '' : parent
}

export function artifactDirectories(artifact: Pick<TaskArtifact, 'path' | 'relative_path' | 'round'>) {
  const relativeParts = artifact.relative_path?.split(/[\\/]/).filter(Boolean) || []
  if (!relativeParts.length) return null
  let roundDirectory = artifact.path.replace(/[\\/]+$/, '')
  for (const _part of relativeParts) roundDirectory = parentDirectory(roundDirectory)
  if (!roundDirectory) return null
  const roundName = roundDirectory.split(/[\\/]/).pop()
  const step = roundName === String(artifact.round)
    ? parentDirectory(roundDirectory)
    : roundDirectory
  const task = parentDirectory(step)
  return step && task ? { task, step } : null
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

function formatUpdatedAt(value: string | null | undefined, locale: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function TaskArtifactBrowser({
  artifacts,
  artifactDirectory,
  projectId,
  steps,
  onOpenArtifact,
}: {
  artifacts: TaskArtifact[]
  artifactDirectory?: string
  projectId?: string
  steps: ArtifactStepDefinition[]
  onOpenArtifact: (name: string, stepKey?: string, round?: number, path?: string) => void
}) {
  const { t, locale } = useI18n()
  const stepGroups = useMemo(
    () => buildArtifactStepGroups(artifacts, steps),
    [artifacts, steps],
  )
  const [selectedRounds, setSelectedRounds] = useState<Record<string, number>>({})
  const [openDirectory, setOpenDirectory] = useState<{ path: string; title: string } | null>(null)
  const taskDirectory = artifactDirectory || artifacts.map(artifactDirectories).find(Boolean)?.task || ''

  if (!stepGroups.length) {
    return <div className="task-detail-artifacts task-artifact-browser-empty">{t('mobile.noArtifacts')}</div>
  }

  return (
    <div className="task-detail-artifacts">
      {taskDirectory && (
        <div className="task-artifact-toolbar">
          <button
            type="button"
            className="task-artifact-open-directory"
            aria-label={`${t('mobile.artifacts')} ${t('taskList.openLocation')}`}
            onClick={() => setOpenDirectory({ path: taskDirectory, title: t('mobile.artifacts') })}
          >
            <Icon name="folder" size={15} /> {t('taskList.openLocation')}
          </button>
        </div>
      )}
      <div className="task-artifact-browser">
        {stepGroups.map((step) => {
          const activeRoundNumber = resolveArtifactRound(
            step.rounds.map((item) => item.round),
            selectedRounds[step.key] ?? null,
          )
          const activeRound = step.rounds.find((item) => item.round === activeRoundNumber)
          if (!activeRound) return null
          const stepDirectory = step.rounds.flatMap((round) => round.artifacts)
            .map(artifactDirectories).find(Boolean)?.step || (taskDirectory ? `${taskDirectory}/${step.key}` : '')
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
            <section key={step.key} className="task-artifact-step-section">
              <div className="task-artifact-step-heading">
                <strong className="task-artifact-step-title">
                  <span className="task-artifact-step-dot" style={{ background: step.color || 'var(--accent)' }} />
                  <MarqueeText text={step.label} />
                </strong>
                <div className="task-artifact-round-tabs" role="tablist" aria-label={`${step.label} ${t('taskDetail.artifactRoundTabsAria')}`}>
                  {step.rounds.map((round) => (
                    <button
                      key={round.round}
                      type="button"
                      role="tab"
                      aria-selected={round.round === activeRoundNumber}
                      onClick={() => setSelectedRounds((current) => ({
                        ...current,
                        [step.key]: round.round,
                      }))}
                    >
                      <span className="task-artifact-round-tab-label">
                        {t('taskDetail.artifactRoundTab', { round: round.round })}
                        {round.artifacts[0]?.round_unchanged_from ? (
                          <ArtifactUnchangedBadge fromRound={round.artifacts[0].round_unchanged_from} />
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
                {stepDirectory && (
                  <button
                    type="button"
                    className="task-artifact-open-directory task-artifact-open-directory--step"
                    aria-label={`${step.label} ${t('taskList.openLocation')}`}
                    title={`${step.label} ${t('taskList.openLocation')}`}
                    onClick={() => setOpenDirectory({
                      path: stepDirectory,
                      title: step.label,
                    })}
                  >
                    <Icon name="folder" size={14} />
                  </button>
                )}
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
                  const artifactUpdatedAt = formatUpdatedAt(artifact.updated_at, locale)
                  const relativePath = artifact.relative_path || artifact.name
                  return (
                    <button
                      key={`${artifact.step_key}:${artifact.round}:${artifact.path}`}
                      type="button"
                      className="task-artifact-file-row"
                      onClick={() => onOpenArtifact(
                        artifact.name,
                        artifact.step_key,
                        artifact.round,
                        artifact.path,
                      )}
                      aria-label={t('taskDetail.openOutputAria', {
                        name: `${artifact.logical_name || artifact.name} (${relativePath})`,
                      })}
                    >
                      <span className="task-artifact-file-main">
                        <Icon name={artifact.is_dir ? 'folder' : 'file'} size={16} />
                        <span className="task-artifact-file-label">
                          <span className="task-artifact-file-name">{artifact.logical_name || artifact.name}</span>
                          <span className="task-artifact-file-relative-path" title={relativePath}>
                            {relativePath}
                          </span>
                        </span>
                        {fileType && <span className="task-artifact-file-type">{fileType}</span>}
                      </span>
                      {artifactUpdatedAt && (
                        <time
                          className="task-artifact-file-updated-at"
                          dateTime={artifact.updated_at || undefined}
                          title={t('taskDetail.artifactModifiedAt', { time: artifactUpdatedAt })}
                        >
                          {artifactUpdatedAt}
                        </time>
                      )}
                      {artifact.unchanged_from_round ? (
                        <ArtifactUnchangedBadge fromRound={artifact.unchanged_from_round} />
                      ) : null}
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
      {openDirectory && projectId && (
        <ProjectDirectoryBrowserDialog
          projectId={projectId}
          title={openDirectory.title}
          rootPath={openDirectory.path}
          displayPath={openDirectory.path}
          onClose={() => setOpenDirectory(null)}
        />
      )}
      {openDirectory && !projectId && artifacts.length > 0 && (
        <TaskArtifactPreviewDialog
          artifact={{
            ...artifacts[0],
            name: openDirectory.title,
            logical_name: openDirectory.title,
            path: openDirectory.path,
            is_dir: true,
          }}
          directoryFiles={artifacts.filter((artifact) => (
            !artifact.is_dir && artifact.path.startsWith(`${openDirectory.path.replace(/[\\/]+$/, '')}/`)
          ))}
          onClose={() => setOpenDirectory(null)}
        />
      )}
    </div>
  )
}
