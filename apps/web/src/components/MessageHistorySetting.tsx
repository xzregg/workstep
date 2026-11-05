import { useEffect, useState } from 'react'
import Button from './Button'
import Input from './Input'
import { useI18n } from '../i18n'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import { validMessageHistoryPageSize, MAX_MESSAGE_HISTORY_PAGE_SIZE } from '../utils/messageHistory'

export default function MessageHistorySetting() {
  const { t } = useI18n()
  const size = useUserSettingsStore(state => state.messageHistoryPageSize)
  const loaded = useUserSettingsStore(state => state.loaded)
  const loading = useUserSettingsStore(state => state.loading)
  const loadError = useUserSettingsStore(state => state.error)
  const load = useUserSettingsStore(state => state.load)
  const save = useUserSettingsStore(state => state.saveMessageHistoryPageSize)
  const [draft, setDraft] = useState(String(size))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void load() }, [load])
  useEffect(() => { setDraft(String(size)) }, [size])
  const value = Number(draft)
  const valid = /^\d+$/.test(draft) && validMessageHistoryPageSize(value)
  const disabled = !loaded || loading || !!loadError || saving
  const submit = async () => {
    if (disabled || !valid || value === size) return
    setSaving(true); setSaved(false); setError('')
    try { await save(value); setSaved(true) }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('settings.messageHistorySaveFailed')) }
    finally { setSaving(false) }
  }
  return <div className="settings-system-group">
    <h2 className="settings-system-heading"><label htmlFor="message-history-page-size">{t('settings.messageHistoryPageSize')}</label></h2>
    <p id="message-history-page-size-hint" className="settings-system-description">{t('settings.messageHistoryPageSizeHint')}</p>
    <div className="settings-system-name-form">
      <Input id="message-history-page-size" type="number" min={1} max={MAX_MESSAGE_HISTORY_PAGE_SIZE} step={1}
        className="settings-system-history-input" value={draft} disabled={disabled}
        aria-describedby="message-history-page-size-hint" aria-invalid={!valid}
        onChange={event => { setDraft(event.target.value); setSaved(false); setError('') }}
        onKeyDown={event => { if (event.key === 'Enter') void submit() }} />
      <Button variant="primary" loading={saving} disabled={disabled || !valid || value === size}
        onClick={() => void submit()}>{t('common.save')}</Button>
    </div>
    {!valid && <p role="alert" className="settings-system-feedback settings-system-feedback--error">{t('settings.messageHistoryInvalid')}</p>}
    {(error || loadError) && <p role="alert" className="settings-system-feedback settings-system-feedback--error">
      {error || loadError}{loadError && <Button variant="ghost" onClick={() => void load(true)}>{t('common.retry')}</Button>}
    </p>}
    {saved && <p role="status" className="settings-system-feedback settings-system-feedback--success">{t('settings.messageHistorySaved')}</p>}
  </div>
}
