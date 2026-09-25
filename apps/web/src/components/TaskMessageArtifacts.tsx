import type { CSSProperties } from 'react'
import type { TaskArtifact } from '../api/client'
import { useI18n } from '../i18n'
import Icon from './Icon'

interface Props {
  artifacts: TaskArtifact[]
  stepColor?: string
  onOpenArtifact: (name: string, stepKey?: string, round?: number, path?: string) => void
}

/** Shows outputs attached to one execution or review message. */
export default function TaskMessageArtifacts({ artifacts, stepColor, onOpenArtifact }: Props) {
  const { t } = useI18n()
  if (artifacts.length === 0) return null

  return <div className="task-message-artifacts"
    style={{ '--task-message-artifact-color': stepColor || 'var(--accent)' } as CSSProperties}>
    <div className="task-message-artifacts-heading">{t('taskDetail.reviewArtifacts')}</div>
    {artifacts.map((artifact) => {
      const open = () => onOpenArtifact(artifact.name, artifact.step_key, artifact.round, artifact.path)
      return <div key={artifact.path} role="button" tabIndex={0}
        className="task-message-artifact"
        aria-label={t('taskDetail.openOutputAria', { name: artifact.name })}
        title={t('taskDetail.openFileTitle', { name: artifact.name })}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            open()
          }
        }}>
        {artifact.is_dir
          ? <Icon name="folder" size={14} color="var(--accent)" className="task-message-artifact-icon" />
          : <span className="task-message-artifact-dot" />}
        <span className="task-message-artifact-name">
          {artifact.name}
          {artifact.round ? <span className="task-message-artifact-round">
            {t('taskDetail.artifactRound', { round: artifact.round })}
          </span> : null}
        </span>
        <span className="task-message-artifact-open">{t('common.open')}</span>
      </div>
    })}
  </div>
}
