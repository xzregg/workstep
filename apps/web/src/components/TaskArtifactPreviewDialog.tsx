import type { Project, TaskArtifact } from '../api/client'
import { useI18n } from '../i18n'
import { useState } from 'react'
import ArtifactPreview from './ArtifactPreview'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import ProjectDirectoryBrowserDialog from './ProjectDirectoryBrowserDialog'
import { usesWebDirectoryBrowser } from '../utils/openLocation'

interface Props {
  artifact: TaskArtifact
  projectId?: string
  projectType?: Project['type']
  onClose: () => void
  onOpenDirectory?: () => void
  canOpenDirectory?: boolean
  directoryFiles?: TaskArtifact[]
}

export default function TaskArtifactPreviewDialog({ artifact, projectId, projectType = 'local', onClose, onOpenDirectory, canOpenDirectory, directoryFiles }: Props) {
  const { t } = useI18n()
  const [selectedFile, setSelectedFile] = useState<TaskArtifact | null>(null)
  const [showDirectoryBrowser, setShowDirectoryBrowser] = useState(false)
  const webDirectoryMode = !!projectId && usesWebDirectoryBrowser(
    projectType,
    typeof window === 'undefined' ? 'localhost' : window.location.hostname,
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
  )
  const directoryPath = artifact.is_dir
    ? artifact.path
    : artifact.path.replace(/[\\/][^\\/]+$/, '')
  return <>
  <div
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
        {(onOpenDirectory || webDirectoryMode) && <Button
          variant="ghost"
          disabled={!webDirectoryMode && !canOpenDirectory}
          onClick={webDirectoryMode ? () => setShowDirectoryBrowser(true) : onOpenDirectory}
        >
          {t('taskDetail.openDirectory')}
        </Button>}
        <Button variant="icon" onClick={onClose}>✕</Button>
      </div>
      <div className="artifact-preview-container" style={{ flex: 1, minHeight: 0 }}>
        {directoryFiles ? (
          <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
            <div style={{ width: 230, flexShrink: 0, overflow: 'auto', borderRight: '1px solid var(--border-soft)', padding: 8 }}>
              {directoryFiles.map((file) => (
                <Button
                  key={file.path}
                  variant="ghost"
                  onClick={() => setSelectedFile(file)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={file.path}
                >
                  {file.path.slice(artifact.path.replace(/\/$/, '').length + 1)}
                </Button>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              {selectedFile && <ArtifactPreview key={selectedFile.path} path={selectedFile.path} projectId={projectId} />}
            </div>
          </div>
        ) : (
          <ArtifactPreview path={artifact.path} projectId={projectId} onClose={onClose} />
        )}
      </div>
    </ResizablePanel>
  </div>
  {showDirectoryBrowser && projectId && (
    <ProjectDirectoryBrowserDialog
      projectId={projectId}
      title={artifact.logical_name || artifact.name}
      rootPath={directoryPath}
      displayPath={directoryPath}
      onClose={() => setShowDirectoryBrowser(false)}
    />
  )}
  </>
}
