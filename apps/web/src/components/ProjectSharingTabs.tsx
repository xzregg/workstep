import { useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { useGatewayConnection } from '../stores/gatewayConnectionStore'
import ProjectPublicationSettings from './ProjectPublicationSettings'
import './ProjectSharingTabs.css'

export default function ProjectSharingTabs({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { t } = useI18n()
  const { status } = useGatewayConnection()
  const [tab, setTab] = useState<'local' | 'gateway'>('local')
  const gatewayAvailable = Boolean(status?.url.trim())
  const selected = gatewayAvailable ? tab : 'local'
  return <div className="project-sharing">
    <div className="project-sharing-tabs" role="tablist" aria-label={t('projectSettings.tabs.share')}>
      <button type="button" role="tab" aria-selected={selected === 'local'}
        onClick={() => setTab('local')}>{t('nav.remoteProjects')}</button>
      {gatewayAvailable && <button type="button" role="tab" data-share-tab="gateway"
        aria-selected={selected === 'gateway'} onClick={() => setTab('gateway')}>
        {t('projectSettings.tabs.access')}
      </button>}
    </div>
    <div role="tabpanel">{selected === 'gateway'
      ? <ProjectPublicationSettings projectId={projectId} /> : children}</div>
  </div>
}
