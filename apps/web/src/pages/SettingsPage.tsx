import SandboxSettings from '../components/SandboxSettings'
import ConfirmDialog from '../components/ConfirmDialog'
import AgentAssistantSettings from './AgentAssistantSettings'
import BotSettings from './BotSettings'
import ResizablePanel from '../components/ResizablePanel'
import GitScanSettings from './GitScanSettings'
import ProjectDirectorySetting from '../components/ProjectDirectorySetting'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import Icon from '../components/Icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import SegmentedControl from '../components/SegmentedControl'
import { providerApi } from '../api/client'
import SettingsNavigation, { type SettingsSection } from '../components/SettingsNavigation'
import EngineSettingsPanel from '../components/EngineSettingsPanel'
import TemplateSettings from './TemplateSettings'
import ProviderSettings from './ProviderSettings'
import RemoteAccessSettings from './RemoteAccessSettings'
import ModelPricingSettings from './ModelPricingSettings'
import GlobalConcurrencySettings from './GlobalConcurrencySettings'
import { useI18n } from '../i18n'
import { useOnboardingStore } from '../stores/onboardingStore'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import { browserPushEnabled, enableBrowserPush } from '../utils/browserPush'
import {
  loadFontSizePreference,
  saveFontSizePreference,
  type FontSizePreference,
} from '../utils/fontSizePreference'
import './SettingsPage.css'


export type { SettingsSection } from '../components/SettingsNavigation'
export type SettingsFocusTarget = 'provider-create' | 'execution-engine'

interface SettingsPageProps {
  onClose: () => void
  initialSection?: SettingsSection
  focusTarget?: SettingsFocusTarget
  preferredProviderId?: string | null
  onConfigurationChanged?: () => void
}

export default function SettingsPage({
  onClose,
  initialSection = 'providers',
  focusTarget,
  preferredProviderId,
  onConfigurationChanged,
}: SettingsPageProps) {
  const { t, locale, setLocale } = useI18n()
  const compactLayout = useCompactLayout()
  const settingsDialogRef = useRef<HTMLDivElement>(null)
  const sandboxDirty = useRef(false)
  const [pendingExit, setPendingExit] = useState<{ section?: SettingsSection } | null>(null)
  const onSandboxDirty = useCallback((dirty: boolean) => { sandboxDirty.current = dirty }, [])
  const closeSettings = () => sandboxDirty.current ? setPendingExit({}) : onClose()
  const selectSection = (section: SettingsSection) => sandboxDirty.current ? setPendingExit({ section }) : setActiveSection(section)
  useOverlay(true, closeSettings, settingsDialogRef, compactLayout)
  const userName = useUserSettingsStore((state) => state.userName)
  const userSettingsLoading = useUserSettingsStore((state) => state.loading)
  const userSettingsError = useUserSettingsStore((state) => state.error)
  const saveUserName = useUserSettingsStore((state) => state.saveUserName)
  const openMode = useUserSettingsStore((state) => state.openMode)
  const saveOpenMode = useUserSettingsStore((state) => state.saveOpenMode)
  const [userNameDraft, setUserNameDraft] = useState(userName)
  const [userNameSaved, setUserNameSaved] = useState(false)
  const [fontSize, setFontSize] = useState(loadFontSizePreference)
  const [engineRefreshRevision, setEngineRefreshRevision] = useState(0)
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(false)
  const [browserNotificationsError, setBrowserNotificationsError] = useState(false)
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)
  const [preferredProviderProtocol, setPreferredProviderProtocol] = useState('')
  useEffect(() => {
    setActiveSection(initialSection)
  }, [initialSection])

  useEffect(() => {
    void browserPushEnabled().then(setBrowserNotificationsEnabled).catch(() => undefined)
  }, [])


  useEffect(() => {
    if (activeSection !== 'engines' || focusTarget !== 'execution-engine') return
    const timer = window.setTimeout(() => {
      document.getElementById('settings-default-execution-engine')?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeSection, focusTarget])

  useEffect(() => {
    if (!preferredProviderId) { setPreferredProviderProtocol(''); return }
    providerApi.list().then((result) => {
      setPreferredProviderProtocol(
        result.providers.find((provider) => provider.id === preferredProviderId)?.protocol || '',
      )
    }).catch(() => setPreferredProviderProtocol(''))
  }, [preferredProviderId])

  useEffect(() => {
    setUserNameDraft(userName)
  }, [userName])

  const handleSaveUserName = async () => {
    if (!await saveUserName(userNameDraft)) return
    setUserNameDraft(userNameDraft.trim())
    setUserNameSaved(true)
  }

  const handleFontSizeChange = (value: FontSizePreference) => {
    setFontSize(value)
    saveFontSizePreference(value)
  }

  return (
    <div
      ref={settingsDialogRef}
      className="modal-overlay settings-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('nav.settings')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSettings()
      }}
    >
      <ConfirmDialog open={Boolean(pendingExit)} title={t('sandbox.discard')}
        onCancel={() => setPendingExit(null)} onConfirm={() => {
          const section = pendingExit?.section
          sandboxDirty.current = false; setPendingExit(null)
          if (section) setActiveSection(section); else onClose()
        }} />
      <ResizablePanel
        className="modal settings-dialog-panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header settings-dialog-header">
          <div className="settings-dialog-title">
            <Icon name="sliders-horizontal" size={18} strokeWidth={2} />
            <span className="modal-title">{t('nav.settings')}</span>
          </div>
          <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={closeSettings}>✕</Button>
        </div>

      <div className="settings-layout">
      <SettingsNavigation activeSection={activeSection} onSelect={selectSection} />

      <section className="settings-content">
        <EngineSettingsPanel hidden={activeSection !== 'engines'} refreshRevision={engineRefreshRevision}
          preferredProviderProtocol={preferredProviderProtocol} focusTarget={focusTarget}
          onConfigurationChanged={onConfigurationChanged} />
        {activeSection !== 'engines' && (activeSection === 'providers' ? (

          <ProviderSettings
            autoCreate={focusTarget === 'provider-create'}
            onChanged={() => {
              setEngineRefreshRevision((current) => current + 1)
              onConfigurationChanged?.()
            }}
          />
        ) : activeSection === 'pricing' ? (
          <ModelPricingSettings />
        ) : activeSection === 'templates' ? (
          <TemplateSettings />
        ) : activeSection === 'channels' ? (
          <BotSettings />
        ) : activeSection === 'remote' ? (
          <RemoteAccessSettings />
        ) : activeSection === 'concurrency' ? (
          <GlobalConcurrencySettings />
        ) : activeSection === 'git' ? (
          <GitScanSettings />
        ) : activeSection === 'sandbox' ? (
          <SandboxSettings onDirtyChange={onSandboxDirty} />
        ) : activeSection === 'system' ? (
          <div className="settings-system-page">
            <h1 className="settings-system-title">{t('settings.systemTitle')}</h1>
            <p className="settings-system-intro">
              {t('settings.systemIntro')}
            </p>
            <div className="settings-system-group">
              <h2 className="settings-system-heading">{t('settings.userName')}</h2>
              <p className="settings-system-description settings-system-description--name">
                {t('settings.userNameIntro')}
              </p>
              <div className="settings-system-name-form">
                <Input
                  value={userNameDraft}
                  onChange={(event) => {
                    setUserNameDraft(event.target.value)
                    setUserNameSaved(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && userNameDraft.trim() && !userSettingsLoading) void handleSaveUserName()
                  }}
                  placeholder={t('settings.userNamePlaceholder')}
                  aria-label={t('settings.userName')}
                  maxLength={80}
                  className="settings-system-name-input"
                />
                <Button
                  variant="primary"
                  loading={userSettingsLoading}
                  disabled={!userNameDraft.trim()}
                  onClick={() => void handleSaveUserName()}
                >
                  {t('common.save')}
                </Button>
              </div>
              {userNameSaved && (
                <div role="status" className="settings-system-feedback settings-system-feedback--success">
                  {t('settings.userNameSaved')}
                </div>
              )}
              {userSettingsError && (
                <div role="status" className="settings-system-feedback settings-system-feedback--error">
                  {userSettingsError}
                </div>
              )}
            </div>
            <ProjectDirectorySetting />
            {typeof Notification !== 'undefined' && !window.WorkStepAndroid && !window.workstepDesktop && (
              <div className="settings-system-group">
                <h2 className="settings-system-heading">{t('settings.browserNotifications')}</h2>
                <p className="settings-system-description">{t('settings.browserNotificationsIntro')}</p>
                <Button variant="ghost" disabled={browserNotificationsEnabled}
                  onClick={() => void enableBrowserPush().then((enabled) => {
                    setBrowserNotificationsEnabled(enabled)
                    setBrowserNotificationsError(!enabled)
                  }).catch(() => setBrowserNotificationsError(true))}>
                  {browserNotificationsEnabled ? t('settings.browserNotificationsEnabled') : t('settings.enableBrowserNotifications')}
                </Button>
                {browserNotificationsError && <p role="status" className="settings-system-feedback settings-system-feedback--error">
                  {t('settings.browserNotificationsError')}
                </p>}
              </div>
            )}
            <div className="settings-system-group">
              <h2 className="settings-system-heading">{t('settings.openMode')}</h2>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={openMode}
                aria-label={t('settings.openMode')}
                disabled={userSettingsLoading}
                onClick={() => void saveOpenMode(!openMode)}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
            <div className="settings-system-group settings-system-font-size">
              <h2 className="settings-system-heading">{t('settings.fontSize')}</h2>
              <p className="settings-system-description">
                {t('settings.fontSizeIntro')}
              </p>
              <SegmentedControl
                ariaLabel={t('settings.fontSize')}
                value={fontSize}
                onChange={handleFontSizeChange}
                options={[
                  { value: 'small', label: t('settings.fontSizeSmall') },
                  { value: 'standard', label: t('settings.fontSizeStandard') },
                  { value: 'large', label: t('settings.fontSizeLarge') },
                  { value: 'extraLarge', label: t('settings.fontSizeExtraLarge') },
                ]}
              />
            </div>
            <div className="settings-system-group">
              <h2 className="settings-system-heading">{t('settings.onboardingTitle')}</h2>
              <p className="settings-system-description">
                {t('settings.onboardingIntro')}
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  useOnboardingStore.getState().reopen()
                  onClose()
                }}
              >
                <Icon name="sparkles" size={16} strokeWidth={2} />
                {t('onboarding.reopen')}
              </Button>
            </div>
            <h2 className="settings-system-heading">{t('nav.language')}</h2>
            <p className="settings-system-description">
              {t('settings.languageIntro')}
            </p>
            <div className="settings-system-language-options"><SegmentedControl
              ariaLabel={t('nav.language')}
              value={locale}
              onChange={setLocale}
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'zh-TW', label: '繁體中文' },
                { value: 'en-US', label: 'English' },
                { value: 'ja-JP', label: '日本語' },
              ]}
            /></div>
          </div>
        ) : (
          <AgentAssistantSettings />
        ))}
      </section>

      </div>
      </ResizablePanel>
      </div>
  )
}
