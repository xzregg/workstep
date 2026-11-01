import { useI18n } from '../i18n'
import { useDesktopUpdates, useDesktopUpdateStore } from '../stores/desktopUpdateStore'
import type { SettingsSection } from '../pages/SettingsPage'
import Button from './Button'
import Icon from './Icon'
import Spinner from './Spinner'

export default function DesktopUpdateRailAction({ onOpenSettings }: { onOpenSettings: (section: SettingsSection) => void }) {
  const { t } = useI18n()
  const { updates, status, automatic, busy, checking, start } = useDesktopUpdates()
  if (!updates?.start || !status?.updateAvailable) return null
  const label = automatic.phase === 'downloading' ? t('settings.autoUpdateDownloading', { percent: automatic.percent })
    : automatic.phase === 'installing' ? t('settings.autoUpdateInstalling')
      : `${t('settings.autoUpdate')} ${status.latestVersion}`
  const update = async () => {
    await start()
    if (useDesktopUpdateStore.getState().automatic.error) onOpenSettings('system')
  }
  return <Button variant="ghost" className="layout-sidebar-nav-button layout-sidebar-external-only desktop-update-rail-button"
    aria-label={label} title={t('settings.autoUpdateHint')} aria-busy={busy} disabled={busy || checking} onClick={() => void update()}>
    {busy ? <Spinner size={17} /> : <Icon name="download" size={17} strokeWidth={2} />}
    <span className="layout-sidebar-action-label">{label}</span>
  </Button>
}
