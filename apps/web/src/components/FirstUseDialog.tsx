import ResizablePanel from './ResizablePanel'
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import { useOnboardingStore } from '../stores/onboardingStore'
import Button from './Button'
import Input from './Input'
import GatewayDesktopAuthentication from './GatewayDesktopAuthentication'

export default function FirstUseDialog() {
  const { t } = useI18n()
  const userName = useUserSettingsStore((state) => state.userName)
  const identitySource = useUserSettingsStore((state) => state.identitySource)
  const loaded = useUserSettingsStore((state) => state.loaded)
  const loading = useUserSettingsStore((state) => state.loading)
  const error = useUserSettingsStore((state) => state.error)
  const load = useUserSettingsStore((state) => state.load)
  const saveUserName = useUserSettingsStore((state) => state.saveUserName)
  const startOnboarding = useOnboardingStore((state) => state.start)
  const dismissOnboarding = useOnboardingStore((state) => state.dismiss)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  if (!loaded) return null
  if (identitySource === 'gateway') return <GatewayDesktopAuthentication />
  if (userName.trim()) return null

  const startGuide = async () => {
    if (await saveUserName(draft)) startOnboarding()
  }

  const skipGuide = async () => {
    if (await saveUserName(draft)) dismissOnboarding()
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 3000 }}>
      <ResizablePanel
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-use-title"
        style={{ width: 420, maxWidth: 'calc(100vw - 32px)' }}
      >
        <div className="modal-header">
          <span id="first-use-title" className="modal-title">{t('onboarding.title')}</span>
        </div>
        <div className="modal-body">
          <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>
            {t('onboarding.intro')}
          </p>
          <label className="field-label" htmlFor="first-use-name">{t('settings.userName')}</label>
          <Input
            id="first-use-name"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim() && !loading) void startGuide()
            }}
            placeholder={t('settings.userNamePlaceholder')}
            autoFocus
            maxLength={80}
          />
          <div style={{ marginTop: 6, color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))' }}>
            {t('onboarding.nameHint')}
          </div>
          {error && (
            <div role="status" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'calc(11px * var(--font-scale))' }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="ghost" disabled={loading || !draft.trim()} onClick={() => void skipGuide()}>
            {t('onboarding.skipGuide')}
          </Button>
          <Button variant="primary" loading={loading} disabled={!draft.trim()} onClick={() => void startGuide()}>
            {t('onboarding.quickStart')}
          </Button>
        </div>
      </ResizablePanel>
    </div>
  )
}
