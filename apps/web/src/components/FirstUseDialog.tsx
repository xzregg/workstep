import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import Button from './Button'
import Input from './Input'

export default function FirstUseDialog() {
  const { t } = useI18n()
  const userName = useUserSettingsStore((state) => state.userName)
  const loaded = useUserSettingsStore((state) => state.loaded)
  const loading = useUserSettingsStore((state) => state.loading)
  const error = useUserSettingsStore((state) => state.error)
  const load = useUserSettingsStore((state) => state.load)
  const saveUserName = useUserSettingsStore((state) => state.saveUserName)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  if (!loaded || userName.trim()) return null

  const save = async () => {
    await saveUserName(draft)
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 3000 }}>
      <div
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
          <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 13 }}>
            {t('onboarding.intro')}
          </p>
          <label className="field-label" htmlFor="first-use-name">{t('settings.userName')}</label>
          <Input
            id="first-use-name"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim() && !loading) void save()
            }}
            placeholder={t('settings.userNamePlaceholder')}
            autoFocus
            maxLength={80}
          />
          <div style={{ marginTop: 6, color: 'var(--meta)', fontSize: 11 }}>
            {t('onboarding.nameHint')}
          </div>
          {error && (
            <div role="status" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 11 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="primary" loading={loading} disabled={!draft.trim()} onClick={() => void save()}>
            {t('onboarding.continue')}
          </Button>
        </div>
      </div>
    </div>
  )
}
