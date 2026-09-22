import { useEffect, useState } from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import Icon from '../components/Icon'
import { useI18n } from '../i18n'
import { useUserSettingsStore } from '../stores/userSettingsStore'

export default function GitScanSettings() {
  const { t } = useI18n()
  const { gitScanDepth, loaded, loading, error: loadError, load, saveGitScanDepth } = useUserSettingsStore()
  const [draft, setDraft] = useState(String(gitScanDepth))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void load() }, [load])
  useEffect(() => { setDraft(String(gitScanDepth)) }, [gitScanDepth])
  const depth = Number(draft)
  const valid = /^\d+$/.test(draft) && Number.isSafeInteger(depth) && depth >= 0
  const disabled = !loaded || loading || !!loadError || saving
  const change = (value: string) => { setDraft(value); setSaved(false); setError('') }
  async function save() {
    if (!valid || disabled || depth === gitScanDepth) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await saveGitScanDepth(depth)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('gitSettings.saveFailed'))
    } finally { setSaving(false) }
  }
  return <section style={{ maxWidth: 680, margin: '0 auto' }}>
    <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 8 }}>{t('gitSettings.title')}</h1>
    <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.7, marginBottom: 28 }}>{t('gitSettings.intro')}</p>
    <label htmlFor="git-scan-depth" style={{ display: 'block', fontSize: 'calc(14px * var(--font-scale))', fontWeight: 600, marginBottom: 8 }}>{t('gitSettings.depth')}</label>
    <p id="git-scan-hint" style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', lineHeight: 1.8, marginBottom: 14 }}>{t('gitSettings.depthHint')}</p>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Input id="git-scan-depth" type="text" inputMode="numeric" pattern="[0-9]*" value={draft} disabled={disabled} aria-describedby="git-scan-hint" aria-invalid={!valid} style={{ width: 100 }} onChange={event => change(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save() }} />
      <span style={{ fontSize: 13 }}>{t('gitSettings.levels')}</span>
      <Button variant="primary" loading={saving} disabled={disabled || !valid || depth === gitScanDepth} onClick={() => void save()}>{t('common.save')}</Button>
      <Button variant="ghost" disabled={disabled || draft === '5'} onClick={() => change('5')}>{t('gitSettings.reset')}</Button>
      {loading && <Icon name="loader-circle" className="git-settings-spinner" size={16} />}
    </div>
    {!valid && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }}>{t('gitSettings.invalid')}</p>}
    {(error || loadError) && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }}>{error || loadError}{loadError && <Button variant="ghost" onClick={() => void load(true)}>{t('common.retry')}</Button>}</div>}
    {saved && <p role="status" style={{ color: 'var(--success)', fontSize: 12, marginTop: 10 }}>{t('gitSettings.saved')}</p>}
    <div style={{ marginTop: 28, padding: 18, border: '1px solid var(--border-soft)', borderRadius: 8, fontSize: 12, lineHeight: 1.8 }}>
      <strong>{t('gitSettings.example')}</strong>
      <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, margin: '12px 0', whiteSpace: 'pre-wrap' }}>{t('gitSettings.exampleTree')}</pre>
      <p style={{ color: 'var(--muted)' }}>{t('gitSettings.worktreeHint')}</p>
    </div>
    <style>{'.git-settings-spinner{animation:git-settings-spin 1s linear infinite}@keyframes git-settings-spin{to{transform:rotate(360deg)}}'}</style>
  </section>
}
