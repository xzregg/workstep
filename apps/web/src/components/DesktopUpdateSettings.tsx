import { useEffect, useState } from 'react'
import Button from './Button'
import { useI18n } from '../i18n'

export interface DesktopUpdateStatus {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  checkedAt: number
  source: 'cache' | 'network'
}

export interface DesktopUpdateBridge {
  status: () => Promise<DesktopUpdateStatus>
  check: () => Promise<DesktopUpdateStatus>
  openDownload: (url: string) => Promise<void>
}

export default function DesktopUpdateSettings() {
  const { t } = useI18n()
  const updates = window.workstepDesktop?.updates
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!updates) return
    void updates.status().then(setStatus).catch(() => setFailed(true))
  }, [updates])

  if (!updates) return null
  const check = async () => {
    setChecking(true); setFailed(false)
    try { setStatus(await updates.check()) } catch { setFailed(true) } finally { setChecking(false) }
  }
  return (
    <div className="settings-system-group desktop-update-settings">
      <h2 className="settings-system-heading">{t('settings.desktopUpdate')}</h2>
      <p className="settings-system-description">{t('settings.desktopUpdateIntro')}</p>
      {status && <p className="desktop-update-version">
        {t('settings.currentVersion', { version: status.currentVersion })}
        {status.updateAvailable && ` · ${t('settings.newVersion', { version: status.latestVersion })}`}
      </p>}
      {status && !status.updateAvailable && <p role="status" className="settings-system-feedback settings-system-feedback--success">
        {t('settings.latestVersion')}
      </p>}
      {failed && <p role="status" className="settings-system-feedback settings-system-feedback--error">
        {t('settings.updateCheckFailed')}
      </p>}
      <div className="desktop-update-actions">
        <Button variant="ghost" loading={checking} onClick={() => void check()}>{t('settings.checkUpdates')}</Button>
        {status?.updateAvailable && <Button variant="primary"
          onClick={() => void updates.openDownload(status.releaseUrl)}>{t('settings.openReleaseDownload')}</Button>}
      </div>
    </div>
  )
}
