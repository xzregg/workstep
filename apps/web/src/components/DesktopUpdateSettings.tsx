import { useDesktopUpdates } from '../stores/desktopUpdateStore'
import Button from './Button'
import Spinner from './Spinner'
import { useI18n } from '../i18n'

export default function DesktopUpdateSettings() {
  const { t } = useI18n()
  const { updates, status, checking, savingPreference, failed, automatic, busy, check, start, setAutomaticCheckEnabled } = useDesktopUpdates()
  if (!updates) return null
  return (
    <div className="settings-system-group desktop-update-settings">
      <h2 className="settings-system-heading">{t('settings.desktopUpdate')}</h2>
      {updates.setAutomaticCheckEnabled && <div className="desktop-update-check-setting">
        <span id="desktop-update-check-label">{t('settings.automaticCheckUpdates')}</span>
        <div className="desktop-update-check-control">
          {savingPreference && <Spinner size={12} />}
          <button type="button" className="settings-switch" role="switch"
            aria-labelledby="desktop-update-check-label" aria-checked={status?.automaticCheckEnabled !== false}
            aria-busy={savingPreference} disabled={checking || savingPreference || busy}
            onClick={() => void setAutomaticCheckEnabled(status?.automaticCheckEnabled === false)}>
            <span className="settings-switch-thumb" />
          </button>
        </div>
      </div>}
      <p className="settings-system-description">{t('settings.desktopUpdateIntro')}</p>
      {status && <p className="desktop-update-version">
        {t('settings.currentVersion', { version: status.currentVersion })}
        {status.updateAvailable && <span>{t('settings.newVersion', { version: status.latestVersion })}</span>}
      </p>}
      {status && status.checkedAt > 0 && !status.updateAvailable && <p role="status" className="settings-system-feedback settings-system-feedback--success">
        {t('settings.latestVersion')}
      </p>}
      {failed && <p role="status" className="settings-system-feedback settings-system-feedback--error">
        {t('settings.updateCheckFailed')}
      </p>}
      {automatic.error && <p role="alert" className="settings-system-feedback settings-system-feedback--error">
        {t('settings.autoUpdateFailed', { error: automatic.error })}
      </p>}
      <p className="settings-system-description">{t('settings.autoUpdateHint')}</p>
      <div className="desktop-update-actions">
        <Button variant="ghost" loading={checking} disabled={busy || savingPreference} onClick={() => void check()}>{t('settings.checkUpdates')}</Button>
        {status?.updateAvailable && updates.start && <Button variant="primary" loading={busy} disabled={checking}
          onClick={() => void start()}>{automatic.phase === 'downloading'
            ? t('settings.autoUpdateDownloading', { percent: automatic.percent })
            : automatic.phase === 'installing' ? t('settings.autoUpdateInstalling') : t('settings.autoUpdate')}</Button>}
        {status?.updateAvailable && <Button variant="ghost"
          onClick={() => void updates.openDownload(status.releaseUrl)}>{t('settings.openReleaseDownload')}</Button>}
      </div>
    </div>
  )
}
