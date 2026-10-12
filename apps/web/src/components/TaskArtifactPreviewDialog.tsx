import type { DirectoryBrowseResult, DirectoryEntry, Project, TaskArtifact } from '../api/client'
import { useI18n } from '../i18n'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import ArtifactPreview from './ArtifactPreview'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import ProjectDirectoryBrowserDialog from './ProjectDirectoryBrowserDialog'
import { usesWebDirectoryBrowser } from '../utils/openLocation'
import './TaskArtifactPreviewDialog.css'

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
  const [showDirectoryBrowser, setShowDirectoryBrowser] = useState(false)
  const browseSharedDirectory = useMemo(() => {
    const rootPath = artifact.path.replace(/\\/g, '/').replace(/\/+$/, '')
    return async (path: string, includeHidden: boolean): Promise<DirectoryBrowseResult> => {
      const currentPath = (path || rootPath).replace(/\\/g, '/').replace(/\/+$/, '')
      const entries = new Map<string, DirectoryEntry>()
      if (currentPath === rootPath || currentPath.startsWith(`${rootPath}/`)) {
        for (const file of directoryFiles || []) {
          const filePath = file.path.replace(/\\/g, '/')
          if (!filePath.startsWith(`${currentPath}/`)) continue
          const parts = filePath.slice(currentPath.length + 1).split('/')
          if (!includeHidden && parts.some(part => part.startsWith('.'))) continue
          const name = parts[0]
          if (!name) continue
          entries.set(name, { name, path: `${currentPath}/${name}`, type: parts.length > 1 || file.is_dir ? 'directory' : 'file' })
        }
      }
      return {
        path: currentPath,
        name: currentPath.split('/').pop() || artifact.name,
        parent: currentPath === rootPath ? null : currentPath.replace(/\/[^/]+$/, ''),
        entries: [...entries.values()].sort((a, b) =>
          Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)),
      }
    }
  }, [artifact.path, artifact.name, directoryFiles])
  const webDirectoryMode = !!projectId && usesWebDirectoryBrowser(
    projectType,
    typeof window === 'undefined' ? 'localhost' : window.location.hostname,
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
  )
  const directoryPath = artifact.is_dir
    ? artifact.path
    : artifact.path.replace(/[\\/][^\\/]+$/, '')
  if (directoryFiles) return (
    <ProjectDirectoryBrowserDialog
      projectId={projectId || ''}
      title={artifact.logical_name || artifact.name}
      rootPath={artifact.path}
      displayPath={artifact.path}
      browseDirectory={browseSharedDirectory}
      readOnly
      onClose={onClose}
    />
  )
  return createPortal(<>
  <div
    role="dialog"
    aria-label={t('taskDetail.artifactPreviewAria', { name: artifact.logical_name || artifact.name })}
    className="task-artifact-preview-backdrop"
    onClick={onClose}
  >
    <ResizablePanel
      minWidth={520}
      minHeight={320}
      className="task-artifact-preview-dialog"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="dialog-header task-artifact-preview-header">
        <div className="task-artifact-preview-heading">
          <div className="task-artifact-preview-title">
            {artifact.logical_name || artifact.name}
          </div>
          <div className="task-artifact-preview-path" title={artifact.path}>
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
      <div className="artifact-preview-container task-artifact-preview-body">
        <ArtifactPreview path={artifact.path} projectId={projectId} onClose={onClose} />
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
  </>, document.body)
}
