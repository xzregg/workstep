import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import Button from './Button'
import Input from './Input'
import DirectoryBrowser from './DirectoryBrowser'

export default function ProjectDirectorySetting() {
  const { t } = useI18n()
  const directory = useUserSettingsStore((state) => state.defaultProjectDirectory)
  const loaded = useUserSettingsStore((state) => state.loaded)
  const load = useUserSettingsStore((state) => state.load)
  const save = useUserSettingsStore((state) => state.saveDefaultProjectDirectory)
  const [draft, setDraft] = useState(directory)
  const [browsing, setBrowsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void load() }, [load])
  useEffect(() => { setDraft(directory) }, [directory])

  const change = (value: string) => {
    setDraft(value)
    setSaved(false)
    setError('')
  }
  const handleSave = async () => {
    if (saving || !loaded || draft.trim() === directory) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await save(draft)
      setSaved(true)
      setBrowsing(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section style={{ paddingBottom: 22, marginBottom: 22, borderBottom: '1px solid var(--border-soft)' }}>
      <h2 style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650, marginBottom: 5 }}>
        <label htmlFor="default-project-directory">{t('settings.defaultProjectDirectory')}</label>
      </h2>
      <p id="default-project-directory-hint" style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 10 }}>
        {t('settings.defaultProjectDirectoryHint')}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input
          id="default-project-directory"
          aria-describedby="default-project-directory-hint"
          value={draft}
          disabled={!loaded || saving}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void handleSave() }}
          placeholder={t('settings.defaultProjectDirectoryPlaceholder')}
          style={{ flex: '1 1 240px', minWidth: 0 }}
        />
        <Button variant="ghost" disabled={!loaded || saving} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>
          {t('settings.browseProjectDirectory')}
        </Button>
        <Button variant="primary" loading={saving} disabled={!loaded || draft.trim() === directory} onClick={() => void handleSave()}>
          {t('common.save')}
        </Button>
      </div>
      {browsing && <div style={{ marginTop: 10 }}><DirectoryBrowser initialPath={directory || undefined} selectedPath={draft} onSelect={change} /></div>}
      {error && <div role="alert" style={{ marginTop: 7, color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>{error}</div>}
      {saved && <div role="status" style={{ marginTop: 7, color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>{t('settings.defaultProjectDirectorySaved')}</div>}
    </section>
  )
}
