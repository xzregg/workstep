import { useI18n } from '../i18n'
import type { TaskArtifact } from '../api/client'
import Button from './Button'
import ArtifactPreview from './ArtifactPreview'
import PromptViewerDialog from './PromptViewerDialog'
import TaskDetailView, { type TaskDetailViewProps } from './TaskDetailView'

export interface TaskDetailPrimaryAction {
  label: string
  disabled?: boolean
  loading?: boolean
  onClick: () => void
}

/**
 * 任务详情的单一页面实现：owner 弹窗与公开分享页都渲染它，
 * 只通过 props 注入不同的数据源、权限和底部主操作。
 */
export interface TaskDetailPageProps extends TaskDetailViewProps {
  primaryAction?: TaskDetailPrimaryAction
  closeLabel?: string
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
}

export default function TaskDetailPage({
  primaryAction,
  closeLabel,
  artifactNotice,
  previewArtifact,
  onCloseArtifactPreview,
  onOpenArtifactDirectory,
  canOpenArtifactDirectory = false,
  viewingPrompt,
  onCloseViewingPrompt,
  overlays,
  onClose,
  ...viewProps
}: TaskDetailPageProps) {
  const { t } = useI18n()

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TaskDetailView {...viewProps} onClose={onClose} />

      {(onClose || primaryAction) && (
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-soft)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {onClose && (
            <Button variant="ghost" onClick={onClose}>
              {closeLabel || t('common.close')}
            </Button>
          )}
          {primaryAction && (
            <Button
              variant="primary"
              disabled={primaryAction.disabled}
              loading={primaryAction.loading}
              onClick={primaryAction.onClick}
              style={primaryAction.disabled ? {
                background: 'var(--border)',
                color: 'var(--meta)',
                borderColor: 'var(--border)',
                cursor: 'not-allowed',
                opacity: 1,
              } : undefined}
            >
              {primaryAction.label}
            </Button>
          )}
        </div>
      )}

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

      {previewArtifact && (
        <div
          role="dialog"          aria-label={t('taskDetail.artifactPreviewAria', {
            name: previewArtifact.logical_name || previewArtifact.name,
          })}
          style={{
            position: 'fixed', inset: 0, zIndex: 1250,
            background: 'rgba(0,0,0,0.35)', padding: '5vh 6vw',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={onCloseArtifactPreview}
        >
          <div
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
                  {previewArtifact.logical_name || previewArtifact.name}
                </div>
                <div style={{
                  fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {previewArtifact.path}
                </div>
              </div>
              {onOpenArtifactDirectory && (
                <Button
                  variant="ghost"
                  disabled={!canOpenArtifactDirectory}
                  onClick={onOpenArtifactDirectory}
                >
                  {t('taskDetail.openDirectory')}
                </Button>
              )}
              <Button variant="icon" onClick={onCloseArtifactPreview}>✕</Button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ArtifactPreview
                path={previewArtifact.path}
                isDir={!!previewArtifact.is_dir}
                projectId={viewProps.projectId}
                onClose={onCloseArtifactPreview}
              />
            </div>
          </div>
        </div>
      )}

      {overlays}
    </div>
  )
}
