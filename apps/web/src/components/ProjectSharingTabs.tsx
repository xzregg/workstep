import { useState } from 'react'
import { useI18n } from '../i18n'
import { useGatewayConnection } from '../stores/gatewayConnectionStore'
import ProjectPublicationSettings from './ProjectPublicationSettings'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import ProjectLocalSharing from './ProjectLocalSharing'
import './ProjectSharingTabs.css'

export default function ProjectSharingTabs({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const { status } = useGatewayConnection()
  const [tab, setTab] = useState<'local' | 'gateway'>('gateway')
  const gatewayAvailable = Boolean(status?.url.trim())
  const remote = isGatewayRemoteBrowser()
  const selected = remote ? 'gateway' : gatewayAvailable ? tab : 'local'
  return <div className="project-sharing">
    <div className="project-sharing-tabs" role="tablist" aria-label={t('projectSettings.tabs.share')}>
      {gatewayAvailable && <button type="button" role="tab" data-share-tab="gateway"
        aria-selected={selected === 'gateway'} onClick={() => setTab('gateway')}>
        {t('projectSettings.tabs.platformAccess')}
      </button>}
      {!remote && <button type="button" role="tab" aria-selected={selected === 'local'}
        onClick={() => setTab('local')}>{t('nav.remoteProjects')}</button>}
    </div>
    {selected === 'gateway' && <div role="tabpanel"><ProjectPublicationSettings projectId={projectId} /></div>}
    {!remote && <div role="tabpanel" hidden={selected !== 'local'}>
      <ProjectLocalSharing projectId={projectId} active={selected === 'local'} />
    </div>}
  </div>
}
