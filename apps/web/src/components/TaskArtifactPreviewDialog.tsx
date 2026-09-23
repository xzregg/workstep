import type { TaskArtifact } from '../api/client'
import { useI18n } from '../i18n'
import ArtifactPreview from './ArtifactPreview'
import Button from './Button'
import ResizablePanel from './ResizablePanel'

interface Props {
  artifact: TaskArtifact
  projectId?: string
  onClose: () => void
  onOpenDirectory?: () => void
  canOpenDirectory?: boolean
}

export default function TaskArtifactPreviewDialog({ artifact, projectId, onClose, onOpenDirectory, canOpenDirectory }: Props) {
  const { t } = useI18n()
  return <div
    role="dialog"
    aria-label={t('taskDetail.artifactPreviewAria', { name: artifact.logical_name || artifact.name })}
    style={{
      position: 'fixed', inset: 0, zIndex: 1250,
      background: 'rgba(0,0,0,0.35)', padding: '5vh 6vw',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
    onClick={onClose}
  >
    <ResizablePanel
      minWidth={520}
      minHeight={320}
      style={{
        width: 'min(900px, 90vw)', height: 'min(720px, 88vh)',
        background: 'var(--bg)', borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
        display: 'flex', flexDirection: 'column',
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="dialog-header" style={{ padding: '12px 16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
            {artifact.logical_name || artifact.name}
          </div>
          <div style={{
            fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {artifact.path}
          </div>
        </div>
        {onOpenDirectory && <Button variant="ghost" disabled={!canOpenDirectory} onClick={onOpenDirectory}>
          {t('taskDetail.openDirectory')}
        </Button>}
        <Button variant="icon" onClick={onClose}>✕</Button>
      </div>
      <div className="artifact-preview-container" style={{ flex: 1, minHeight: 0 }}>
        <ArtifactPreview path={artifact.path} projectId={projectId} onClose={onClose} />
      </div>
    </ResizablePanel>
  </div>
}
