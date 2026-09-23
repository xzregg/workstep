import { useI18n } from '../i18n'
import type { TaskArtifact } from '../api/client'
import Button from './Button'
import PromptViewerDialog from './PromptViewerDialog'
import TaskDetailView, { type TaskDetailViewProps } from './TaskDetailView'
import ProjectDirectoryBrowserDialog from './ProjectDirectoryBrowserDialog'
import TaskArtifactPreviewDialog from './TaskArtifactPreviewDialog'
import {
  MarkdownAssetUrlProvider,
  type MarkdownUrlResolver,
} from '../contexts/MarkdownAssetUrlContext'

/**
 * 任务详情的单一页面实现：owner 弹窗与公开分享页都渲染它。
 */
export interface TaskDetailPageProps extends TaskDetailViewProps {
  artifactNotice?: string
  /** 产物预览的挂载与关闭由调用方管理状态，这里只负责统一渲染。 */
  previewArtifact?: TaskArtifact | null
  onCloseArtifactPreview?: () => void
  onOpenArtifactDirectory?: () => void
  canOpenArtifactDirectory?: boolean
  viewingPrompt?: string | null
  onCloseViewingPrompt?: () => void
  /** 额外浮层（如 owner 的分享弹窗、提示词编辑框）由调用方注入。 */
  overlays?: React.ReactNode
  /** Resolve project-relative Markdown uploads for session-scoped public views. */
  markdownUrlResolver?: MarkdownUrlResolver
}

export default function TaskDetailPage({
  artifactNotice,
  previewArtifact,
  onCloseArtifactPreview,
  onOpenArtifactDirectory,
  canOpenArtifactDirectory = false,
  viewingPrompt,
  onCloseViewingPrompt,
  overlays,
  markdownUrlResolver,
  onClose,
  ...viewProps
}: TaskDetailPageProps) {
  const { t } = useI18n()

  return (
    <MarkdownAssetUrlProvider resolver={markdownUrlResolver}>
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TaskDetailView {...viewProps} onClose={onClose} />

      {artifactNotice && (
        <div style={{
          position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1300, padding: '8px 16px', borderRadius: 6,
          background: 'var(--fg)', color: 'var(--bg)', fontSize: 'calc(13px * var(--font-scale))',
          boxShadow: 'var(--elev-raised)',
        }}>
          {artifactNotice}
        </div>
      )}

      {viewingPrompt && (
        <PromptViewerDialog
          prompt={viewingPrompt}
          projectId={viewProps.projectId || undefined}
          onClose={() => onCloseViewingPrompt?.()}
        />
      )}

      {previewArtifact?.is_dir ? (
        <ProjectDirectoryBrowserDialog
          projectId={viewProps.projectId || ''}
          title={previewArtifact.logical_name || previewArtifact.name}
          rootPath={previewArtifact.path}
          displayPath={previewArtifact.path}
          headerActions={onOpenArtifactDirectory ? (
            <Button
              variant="ghost"
              disabled={!canOpenArtifactDirectory}
              onClick={onOpenArtifactDirectory}
            >
              {t('taskDetail.openDirectory')}
            </Button>
          ) : null}
          onClose={() => onCloseArtifactPreview?.()}
        />
      ) : previewArtifact ? (
        <TaskArtifactPreviewDialog
          artifact={previewArtifact}
          projectId={viewProps.projectId}
          onClose={() => onCloseArtifactPreview?.()}
          onOpenDirectory={onOpenArtifactDirectory}
          canOpenDirectory={canOpenArtifactDirectory}
        />
      ) : null}

      {overlays}
    </div>
    </MarkdownAssetUrlProvider>
  )
}
