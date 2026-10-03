import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useI18n } from '../i18n'
import type { Project, TaskArtifact } from '../api/client'
import type { GitWorkspaceBrowser } from './git/GitApiContext'
import Button from './Button'
import PromptViewerDialog from './PromptViewerDialog'
import TaskDetailView, { type TaskDetailViewProps } from './TaskDetailView'
import ProjectDirectoryBrowserDialog from './ProjectDirectoryBrowserDialog'
import TaskArtifactPreviewDialog from './TaskArtifactPreviewDialog'
import { GitApiContext } from './git/GitApiContext'
import { gitApi, type GitApi } from '../api/git'
import {
  MarkdownAssetUrlProvider,
  type MarkdownUrlResolver,
  type TaskFilePreview,
} from '../contexts/MarkdownAssetUrlContext'

/**
 * 任务详情的单一页面实现：owner 弹窗与公开分享页都渲染它。
 */
/** Both the owner and share routes must supply every task-detail viewing capability. */
export interface TaskDetailReadCapabilities {
  artifactDirectory: string
  resolveAssetUrl: MarkdownUrlResolver
  filePreview: TaskFilePreview
  loadMessageEvents: NonNullable<TaskDetailViewProps['onLoadMessageEvents']>
  openArtifact: TaskDetailViewProps['onOpenArtifact']
  loadExecutionReport: NonNullable<TaskDetailViewProps['executionReportLoader']>
  browseGitWorkspace: GitWorkspaceBrowser
}

export interface TaskDetailGitCapability {
  api: GitApi
  projectId: string
  shared?: boolean
  projectScoped?: boolean
  readOnly?: boolean
  workspaceEditable?: boolean
  allowedActions?: readonly string[]
}

export interface TaskDetailPageProps extends Omit<
  TaskDetailViewProps,
  'onLoadMessageEvents' | 'onOpenArtifact' | 'executionReportLoader' | 'gitEnabled' | 'gitProjectId'
> {
  readCapabilities: TaskDetailReadCapabilities
  gitCapability?: TaskDetailGitCapability
  artifactNotice?: string
  /** 产物预览的挂载与关闭由调用方管理状态，这里只负责统一渲染。 */
  previewArtifact?: TaskArtifact | null
  onCloseArtifactPreview?: () => void
  onOpenArtifactDirectory?: () => void
  canOpenArtifactDirectory?: boolean
  projectType?: Project['type']
  viewingPrompt?: string | null
  onCloseViewingPrompt?: () => void
  /** 额外浮层（如 owner 的分享弹窗、提示词编辑框）由调用方注入。 */
  overlays?: React.ReactNode
}

export default function TaskDetailPage({
  artifactNotice,
  previewArtifact,
  onCloseArtifactPreview,
  onOpenArtifactDirectory,
  canOpenArtifactDirectory = false,
  projectType,
  viewingPrompt,
  onCloseViewingPrompt,
  overlays,
  readCapabilities,
  gitCapability,
  onClose,
  ...viewProps
}: TaskDetailPageProps) {
  const { t } = useI18n()
  const { canEdit } = useGatewayProjectPermissions(viewProps.projectId)
  if (!canEdit) {
    viewProps = { ...viewProps, chatEnabled: false, descriptionEditable: false, reviewConfigEditable: false,
      onSend: undefined, onSendPrompt: undefined, onStop: undefined, onStopStep: undefined,
      onOpenPromptEditor: undefined, onRestartStepWithFreshSession: undefined,
      onRetryFailedMessage: undefined, onSetFailedExecutionComplete: undefined,
      onReviewAction: undefined, onA2uiAction: undefined, onInteractionRespond: undefined,
      onProposalOverride: undefined }
  }

  return (
    <GitApiContext.Provider value={{ api: gitCapability?.api || gitApi, shared: !!gitCapability?.shared, projectScoped: gitCapability?.projectScoped, workspaceEditable: gitCapability?.workspaceEditable, allowedActions: gitCapability?.allowedActions, readOnly: !!gitCapability?.readOnly, browseWorkspace: readCapabilities.browseGitWorkspace }}>
    <MarkdownAssetUrlProvider resolver={readCapabilities.resolveAssetUrl} filePreview={readCapabilities.filePreview}>
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TaskDetailView
        {...viewProps}
        artifactDirectory={readCapabilities.artifactDirectory}
        gitEnabled={!!gitCapability}
        gitProjectId={gitCapability?.projectId}
        onClose={onClose}
        onLoadMessageEvents={readCapabilities.loadMessageEvents}
        onOpenArtifact={readCapabilities.openArtifact}
        executionReportLoader={readCapabilities.loadExecutionReport}
      />

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

      {previewArtifact?.is_dir && !viewProps.projectId ? (
        <TaskArtifactPreviewDialog
          artifact={previewArtifact}
          directoryFiles={viewProps.artifacts.filter((item) => (
            !item.is_dir && item.path.startsWith(`${previewArtifact.path.replace(/\/$/, '')}/`)
          ))}
          onClose={() => onCloseArtifactPreview?.()}
        />
      ) : previewArtifact?.is_dir ? (
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
          projectType={projectType}
          onClose={() => onCloseArtifactPreview?.()}
          onOpenDirectory={onOpenArtifactDirectory}
          canOpenDirectory={canOpenArtifactDirectory}
        />
      ) : null}

      {overlays}
    </div>
    </MarkdownAssetUrlProvider>
    </GitApiContext.Provider>
  )
}
