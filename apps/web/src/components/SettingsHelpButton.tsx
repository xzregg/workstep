import { useState } from 'react'
import type { SettingsSection } from './SettingsNavigation'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import ManualHelpDialog from './ManualHelpDialog'
import './ManualHelpDialog.css'

export const settingsManualChapters: Partial<Record<SettingsSection, string>> = {
  'digital-person': 'digital-person', providers: 'sdk-credentials', engines: 'sdk-installation',
  assistants: 'settings-troubleshooting', speech: 'chat-skills', pricing: 'faq',
  templates: 'templates-ai-flow', connectors: 'chat-skills', roles: 'chat-skills',
  channels: 'bots', remote: 'sharing-remote', concurrency: 'settings-troubleshooting',
  git: 'git', appearance: 'appearance', system: 'settings-troubleshooting',
  feedback: 'settings-troubleshooting', sandbox: 'sandbox', decision: 'settings-troubleshooting',
}

export default function SettingsHelpButton({ section }: { section: SettingsSection }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const chapter = settingsManualChapters[section]
  if (!chapter) return null
  return <>
    <Button type="button" variant="icon" size="sm" className="settings-help-button"
      title={t('manualHelp.open')} aria-label={t('manualHelp.open')}
      onClick={() => setOpen(true)}><Icon name="circle-help" size={16} /></Button>
    {open && <ManualHelpDialog key={chapter} chapter={chapter} onClose={() => setOpen(false)} />}
  </>
}
