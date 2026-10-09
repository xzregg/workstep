import { useState } from 'react'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import ResizablePanel from './ResizablePanel'
import ProjectSharingTabs from './ProjectSharingTabs'
import './GatewayProjectSettings.css'

export default function GatewayProjectSettings({ projectId, projectName, onClose }: {
  projectId: string; projectName: string; onClose: () => void
}) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'general' | 'share'>('general')
  return <div className="modal-overlay" onClick={onClose}>
    <ResizablePanel className="modal gateway-project-settings" role="dialog" aria-modal="true"
      aria-labelledby="gateway-project-settings-title" onClick={event => event.stopPropagation()}>
      <div className="modal-header">
        <span id="gateway-project-settings-title" className="modal-title">{t('projectSettings.title')}</span>
        <Button variant="icon" aria-label={t('common.close')} onClick={onClose}><Icon name="x" size={16} /></Button>
      </div>
      <div className="gateway-project-settings-tabs" role="tablist">
        <Button role="tab" aria-selected={tab === 'general'} onClick={() => setTab('general')}>
          {t('projectSettings.tabs.general')}
        </Button>
        <Button role="tab" aria-selected={tab === 'share'} onClick={() => setTab('share')}>
          {t('projectSettings.tabs.share')}
        </Button>
      </div>
      <div className="modal-body" role="tabpanel">{tab === 'general'
        ? <p>{t('projectSettings.general.name')}：{projectName}</p>
        : <ProjectSharingTabs projectId={projectId}>{null}</ProjectSharingTabs>}</div>
    </ResizablePanel>
  </div>
}
