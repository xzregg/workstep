import { ArrowRight, Check, Copy, Globe2, KeyRound, Monitor, Network, Smartphone, User } from 'lucide-react'
import { useI18n } from '../i18n'

const SHARE_VALUE =
  'workstep://remote-project/v1/eyJ2ZXJzaW9uIjoxLCJlbmRwb2ludCI6IndzOi8vMTkyLjE2OC4xLjIwOjg3NjUvc2hhcmUvdnEiLCJwcm9qZWN0X2lkIjoiQml0RnVuIiwicHJvamVjdF9uYW1lIjoiQml0RnVuIiwiaW52aXRlX3Rva2VuIjoiNXkxS3lQN1ZGa0t4WmJwOXZxNlhkc0lKN1FvbmVVR1BObSIsImZpbmdlcnByaW50IjoiYjEwZjRjNTJkNDQ3NWE3YjFlZTBiMTJiNjBjMWY3MmYifQ'

export function RemoteShare() {
  const { t } = useI18n()

  const devices = [
    { connected: true, user: t('remoteShare.device1User'), device: t('remoteShare.device1Name') },
    { connected: true, user: t('remoteShare.device2User'), device: t('remoteShare.device2Name') },
    { connected: false, user: t('remoteShare.device3User'), device: t('remoteShare.device3Name') },
  ]

  return (
    <section className="section section-alt" id="remote">
      <div className="container">
        <div className="section-eyebrow">{t('remoteShare.eyebrow')}</div>
        <h2 className="section-title">{t('remoteShare.title')}</h2>
        <p className="section-lede">{t('remoteShare.lede')}</p>

        <div className="remote-layout">
          <div className="remote-visual">
            <div className="remote-window">
              <div className="remote-window-bar">
                <span className="remote-window-title">{t('remoteShare.dialogTitle')} · BitFun</span>
                <span className="remote-window-close">✕</span>
              </div>
              <div className="remote-window-body">
                <div className="remote-field-label">{t('remoteShare.accessType')}</div>
                <div className="remote-access-row">
                  <span className="remote-access-btn is-active">{t('remoteShare.internalAccess')}</span>
                  <span className="remote-access-btn">{t('remoteShare.externalAccess')}</span>
                </div>
                <p className="remote-access-hint">{t('remoteShare.internalAccessHint')}</p>
                <div className="remote-field-label">{t('remoteShare.shareStringLabel')}</div>
                <div className="remote-share-box">
                  <code>{SHARE_VALUE}</code>
                </div>
                <div className="remote-devices-head">
                  <span>{t('remoteShare.onlineDevices')}</span>
                  <span className="remote-live-dot" />
                </div>
                <div className="remote-device-list">
                  {devices.map((device) => (
                    <div key={device.user} className="remote-device">
                      <span className={`remote-dot ${device.connected ? 'is-on' : ''}`}>{device.connected ? '●' : '○'}</span>
                      <span className="remote-device-user">{device.user}</span>
                      <span className="remote-device-name">{device.device}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="remote-window-footer">
                <span className="remote-footer-btn">{t('common.close')}</span>
                <span className="remote-footer-btn">
                  <Copy size={12} />
                  {t('common.copy')}
                </span>
                <span className="remote-footer-btn is-primary">
                  <KeyRound size={12} />
                  {t('remoteShare.generateShare')}
                </span>
              </div>
            </div>
            <div className="remote-settings-card">
              <div className="remote-settings-title">
                <Globe2 size={14} />
                {t('remoteShare.settingsTitle')}
              </div>
              <div className="remote-settings-row">
                <span className="remote-settings-label">{t('remoteShare.internalAddress')}</span>
                <code className="remote-settings-value">http://192.168.1.20:8765</code>
              </div>
              <div className="remote-settings-row">
                <span className="remote-settings-label">{t('remoteShare.externalAddress')}</span>
                <code className="remote-settings-value">https://workstep.example.com</code>
              </div>
              <div className="remote-settings-row">
                <span className="remote-settings-label">{t('remoteShare.authorizedDevices')}</span>
                <span className="remote-settings-badge">{t('remoteShare.onlineDevices')}</span>
              </div>
            </div>
          </div>

          <div className="remote-copy">
            <div className="remote-feature-card">
              <span className="remote-feature-icon">
                <KeyRound size={17} />
              </span>
              <h3>{t('remoteShare.feature1Title')}</h3>
              <p>{t('remoteShare.feature1Desc')}</p>
            </div>
            <div className="remote-feature-card">
              <span className="remote-feature-icon">
                <Network size={17} />
              </span>
              <h3>{t('remoteShare.feature2Title')}</h3>
              <p>{t('remoteShare.feature2Desc')}</p>
            </div>
            <div className="remote-feature-card">
              <span className="remote-feature-icon">
                <Monitor size={17} />
              </span>
              <h3>{t('remoteShare.feature3Title')}</h3>
              <p>{t('remoteShare.feature3Desc')}</p>
            </div>

            <div className="remote-flow">
              <div className="remote-flow-title">{t('remoteShare.flowTitle')}</div>
              <div className="remote-flow-steps">
                <div className="remote-flow-step">
                  <span className="remote-flow-icon">
                    <ShareMini />
                  </span>
                  <div>
                    <strong>{t('remoteShare.flowStep1Title')}</strong>
                    <p>{t('remoteShare.flowStep1Desc')}</p>
                  </div>
                </div>
                <ArrowRight className="remote-flow-arrow" size={15} />
                <div className="remote-flow-step">
                  <span className="remote-flow-icon">
                    <Smartphone size={15} />
                  </span>
                  <div>
                    <strong>{t('remoteShare.flowStep2Title')}</strong>
                    <p>{t('remoteShare.flowStep2Desc')}</p>
                  </div>
                </div>
                <ArrowRight className="remote-flow-arrow" size={15} />
                <div className="remote-flow-step">
                  <span className="remote-flow-icon">
                    <Check size={15} />
                  </span>
                  <div>
                    <strong>{t('remoteShare.flowStep3Title')}</strong>
                    <p>{t('remoteShare.flowStep3Desc')}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="remote-note">
              <User size={13} />
              {t('remoteShare.note')}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ShareMini() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
    </svg>
  )
}
