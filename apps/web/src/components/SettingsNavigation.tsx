import Icon, { type IconName } from './Icon'
import { useI18n } from '../i18n'
import './SettingsNavigation.css'

export type SettingsSection = 'connectors' | 'engines' | 'providers' | 'pricing' | 'assistants' | 'templates' | 'roles' | 'channels' | 'remote' | 'concurrency' | 'git' | 'appearance' | 'system' | 'feedback' | 'sandbox' | 'speech' | 'decision'

const sections: { id: SettingsSection; label: string; icon?: IconName; glyph?: string }[] = [
  { id: 'providers', label: 'providerSettings.nav', icon: 'sliders-horizontal' },
  { id: 'engines', label: 'settings.enginesNav', icon: 'sliders-horizontal' },
  { id: 'decision', label: 'decisionModels.title', icon: 'layers' },
  { id: 'assistants', label: 'settings.assistantNav', glyph: '✦' },
  { id: 'speech', label: 'speech.title', icon: 'mic' },
  { id: 'pricing', label: 'settings.pricingNav', icon: 'layers' },
  { id: 'templates', label: 'settings.templatesNav', icon: 'layout-grid' },
  { id: 'connectors', label: 'connectors.title', icon: 'plug' },
  { id: 'roles', label: 'roleCenter.title', icon: 'drama' },
  { id: 'channels', label: 'channelBot.title', icon: 'bot' },
  { id: 'remote', label: 'settings.remoteAccessTitle', icon: 'share' },
  { id: 'concurrency', label: 'projectSettings.tabs.concurrency', icon: 'layers' },
  { id: 'git', label: 'gitSettings.title', icon: 'git-fork' },
  { id: 'appearance', label: 'skins.appearance', icon: 'sparkles' },
  { id: 'system', label: 'settings.systemNav', glyph: '文' },
  { id: 'feedback', label: 'settings.problemFeedback', icon: 'external-link' },
  { id: 'sandbox', label: 'sandbox.title', icon: 'layers' },
]

export default function SettingsNavigation({
  activeSection,
  onSelect,
}: {
  activeSection: SettingsSection
  onSelect: (section: SettingsSection) => void
}) {
  const { t } = useI18n()
  return (
    <aside className="settings-nav">
      {sections.filter(section => section.id !== 'sandbox' || window.workstepDesktop?.sandbox).map(({ id, label, icon, glyph }) => (
        <div className="settings-nav-item" key={id}>
        {id === 'providers' && <div className="settings-nav-heading">{t('decisionModels.modelGroup')}</div>}
        {id === 'templates' && <div className="settings-nav-heading settings-nav-group-heading">{t('decisionModels.workspaceGroup')}</div>}
        {id === 'appearance' && <div className="settings-nav-separator" />}
        <button
          type="button"
          className="settings-nav-button"
          aria-current={activeSection === id ? 'page' : undefined}
          onClick={() => onSelect(id)}
        >
          {icon ? <Icon name={icon} size={16} strokeWidth={2} /> : <span className="settings-nav-glyph" aria-hidden="true">{glyph}</span>}
          {t(label as Parameters<typeof t>[0])}
        </button>
        </div>
      ))}
      {window.workstepDesktop && <div className="settings-nav-caption">{t('decisionModels.desktop')}</div>}
    </aside>
  )
}
