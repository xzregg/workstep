import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import Button from './Button'
import Input from './Input'
import DirectoryBrowser from './DirectoryBrowser'
import './ProjectDirectorySetting.css'

export default function ProjectDirectorySetting() {
  const { t } = useI18n()
  const directory = useUserSettingsStore((state) => state.defaultProjectDirectory)
  const restricted = useUserSettingsStore((state) => state.restrictFileAccessRoot)
  const loaded = useUserSettingsStore((state) => state.loaded)
  const load = useUserSettingsStore((state) => state.load)
  const save = useUserSettingsStore((state) => state.saveDefaultProjectDirectory)
  const [draft, setDraft] = useState(directory)
  const [restrictedDraft, setRestrictedDraft] = useState(restricted)
  const [browsing, setBrowsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void load() }, [load])
  useEffect(() => { setDraft(directory) }, [directory])
  useEffect(() => { setRestrictedDraft(restricted) }, [restricted])
  const dirty = draft.trim() !== directory || restrictedDraft !== restricted

  const change = (value: string) => {
    setDraft(value)
    setSaved(false)
    setError('')
  }
  const handleSave = async () => {
    if (saving || !loaded || !dirty) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await save(draft, restrictedDraft)
      setSaved(true)
      setBrowsing(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="project-directory-setting">
      <h2>
        <label htmlFor="default-project-directory">{t('settings.defaultProjectDirectory')}</label>
      </h2>
      <p id="default-project-directory-hint" className="project-directory-setting-hint">
        {t('settings.defaultProjectDirectoryHint')}
      </p>
      <div className="project-directory-setting-fields">
        <Input
          id="default-project-directory"
          aria-describedby="default-project-directory-hint"
          value={draft}
          disabled={!loaded || saving}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void handleSave() }}
          placeholder={t('settings.defaultProjectDirectoryPlaceholder')}
          className="project-directory-setting-input"
        />
        <Button variant="ghost" disabled={!loaded || saving} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>
          {t('settings.browseProjectDirectory')}
        </Button>
      </div>
      {browsing && <div className="project-directory-setting-browser"><DirectoryBrowser initialPath={directory || undefined} selectedPath={draft} onSelect={change} /></div>}
      <div className="project-directory-setting-restriction">
        <label htmlFor="restrict-file-access-root">{t('settings.restrictFileAccessRoot')}</label>
        <button id="restrict-file-access-root" type="button" className="settings-switch" role="switch"
          aria-checked={restrictedDraft} aria-describedby="file-access-root-hint" aria-label={t('settings.restrictFileAccessRoot')}
          disabled={!loaded || saving} onClick={() => { setRestrictedDraft(!restrictedDraft); setSaved(false); setError('') }}><span className="settings-switch-thumb" /></button>
      </div>
      <p id="file-access-root-hint" className="project-directory-setting-hint">{t('settings.fileAccessRootHint')}</p>
      <div className="project-directory-setting-actions">
        <Button className="project-directory-setting-save" variant="primary" loading={saving} disabled={!loaded || !dirty || saving} onClick={() => void handleSave()}>
          {t('common.save')}
        </Button>
      </div>
      {error && <div role="alert" className="project-directory-setting-error">{error}</div>}
      {saved && <div role="status" className="project-directory-setting-saved">{t('settings.defaultProjectDirectorySaved')}</div>}
    </section>
  )
}
