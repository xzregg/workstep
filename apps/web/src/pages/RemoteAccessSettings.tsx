import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { useState } from 'react'
import { useI18n } from '../i18n'
import { isWebRtcRemoteBrowser } from '../webrtc/webrtcLocation'
import WebRtcP2pSettings from '../components/webrtc/WebRtcP2pSettings'
import GatewayPlatformSettings from './GatewayPlatformSettings'
import RemoteProjectSettings from './RemoteProjectSettings'
import './RemoteAccessSettings.css'

export default function RemoteAccessSettings() {
 const gatewayRemote = isGatewayRemoteBrowser()
 const webrtcRemote = isWebRtcRemoteBrowser()
 const remoteReadOnly = gatewayRemote || webrtcRemote
 const { t } = useI18n()
 const [tab, setTab] = useState<'gateway' | 'webrtc' | 'legacy'>(webrtcRemote ? 'webrtc' : 'gateway')
 const activeTab = webrtcRemote ? 'webrtc' : gatewayRemote ? 'gateway' : tab
 return <div className="remote-access-settings">
  <nav className="remote-access-tabs" aria-label={t('settings.remoteAccessTitle')}>
   {(!remoteReadOnly || gatewayRemote) && (
    <button type="button" disabled={remoteReadOnly} aria-current={activeTab === 'gateway' ? 'page' : undefined} onClick={() => setTab('gateway')}>{t('gatewayPlatform.title')}</button>
   )}
   {(!remoteReadOnly || webrtcRemote) && (
    <button type="button" disabled={remoteReadOnly} aria-current={activeTab === 'webrtc' ? 'page' : undefined} onClick={() => setTab('webrtc')}>{t('webrtcP2p.title')}</button>
   )}
   {!remoteReadOnly && <button type="button" aria-current={activeTab === 'legacy' ? 'page' : undefined} onClick={() => setTab('legacy')}>{t('nav.remoteProjects')}</button>}
  </nav>
  {activeTab === 'gateway' ? <GatewayPlatformSettings /> : activeTab === 'webrtc' ? <WebRtcP2pSettings /> : <RemoteProjectSettings />}
 </div>
}
