import Icon, { type IconName } from './Icon'
import { useI18n } from '../i18n'
import './SettingsNavigation.css'

export type SettingsSection = 'engines' | 'providers' | 'pricing' | 'assistants' | 'templates' | 'channels' | 'remote' | 'concurrency' | 'git' | 'system'

const sections: { id: SettingsSection; label: string; icon?: IconName; glyph?: string }[] = [
  { id: 'providers', label: 'providerSettings.nav', icon: 'sliders-horizontal' },
  { id: 'engines', label: 'settings.enginesNav', icon: 'sliders-horizontal' },
  { id: 'pricing', label: 'settings.pricingNav', icon: 'layers' },
  { id: 'assistants', label: 'settings.assistantNav', glyph: '✦' },
  { id: 'templates', label: 'settings.templatesNav', icon: 'layout-grid' },
  { id: 'channels', label: 'nav.channels', icon: 'radio' },
  { id: 'remote', label: 'nav.remoteProjects', icon: 'share' },
  { id: 'concurrency', label: 'projectSettings.tabs.concurrency', icon: 'layers' },
  { id: 'git', label: 'gitSettings.title', icon: 'git-fork' },
  { id: 'system', label: 'settings.systemNav', glyph: '文' },
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
      <div className="settings-nav-heading">{t('nav.settings')}</div>
      {sections.map(({ id, label, icon, glyph }) => (
        <button
          key={id}
          type="button"
          className="settings-nav-button"
          aria-current={activeSection === id ? 'page' : undefined}
          onClick={() => onSelect(id)}
        >
          {icon ? <Icon name={icon} size={16} strokeWidth={2} /> : <span className="settings-nav-glyph" aria-hidden="true">{glyph}</span>}
          {t(label as Parameters<typeof t>[0])}
        </button>
      ))}
    </aside>
  )
}
