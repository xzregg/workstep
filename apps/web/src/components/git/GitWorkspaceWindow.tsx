import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../../hooks/useOverlay'
import { useI18n } from '../../i18n'
import GitWorkspace from '../../pages/GitWorkspace'
import ResizablePanel from '../ResizablePanel'
import Button from '../Button'
import Icon from '../Icon'

export default function GitWorkspaceWindow({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useI18n()
  const panel = useRef<HTMLDivElement>(null)
  useOverlay(true, onClose, panel, false)
  return createPortal(<div className="git-window-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <ResizablePanel ref={panel} className="git-window" role="dialog" aria-modal="true" aria-label={t('git.title')} tabIndex={-1} minWidth={760} minHeight={420}>
      <header className="git-window-header" data-dialog-drag-handle>
        <Icon name="git-fork" size={16} /><strong>{t('git.title')}</strong>
        <Button variant="icon" className="git-window-close" aria-label={t('common.close')} onClick={onClose}><Icon name="x" size={16} /></Button>
      </header>
      <div className="git-window-content"><GitWorkspace embeddedProjectId={projectId} /></div>
    </ResizablePanel>
  </div>, document.body)
}
