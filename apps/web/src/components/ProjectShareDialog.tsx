import ResizablePanel from './ResizablePanel'
import type { Project } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import ProjectSharingTabs from './ProjectSharingTabs'
import './ProjectLocalSharing.css'

export default function ProjectShareDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const { t } = useI18n()
  if (!project) return null
  return <div className="modal-overlay" onClick={onClose}>
    <ResizablePanel className="modal project-share-dialog" role="dialog" aria-modal="true"
      aria-label={`${t('projectSettings.tabs.share')} · ${project.name}`} onClick={event => event.stopPropagation()}>
      <div className="modal-header">
        <span className="modal-title">{t('projectSettings.tabs.share')} · {project.name}</span>
        <Button variant="icon" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <div className="modal-body"><ProjectSharingTabs projectId={project.id} /></div>
      <div className="modal-footer"><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button></div>
    </ResizablePanel>
  </div>
}
