import { useEffect, useState } from 'react'
import { channelBotApi, type ChannelBot, type DirectoryStatus, type DirectoryContact } from '../api/channelBots'
import { useI18n } from '../i18n'
import Button from './Button'
import Input from './Input'
import Spinner from './Spinner'
import './BotDirectorySettings.css'

/** Owns directory credentials, validation and local-cache browsing. */
export default function BotDirectorySettings({ bot, onDirtyChange, onBusyChange }: {
  bot: ChannelBot; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void
}) {
  const { t } = useI18n()
  const [initial, setInitial] = useState(() => ({ directory_enabled: bot.directory_enabled ?? false,
    directory_corp_id: bot.directory_corp_id || '', directory_agent_id: bot.directory_agent_id || '', directory_secret: '' }))
  const [draft, setDraft] = useState(initial)
  const [hasSecret, setHasSecret] = useState(bot.has_directory_secret)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<DirectoryStatus | null>(null)
  const [contacts, setContacts] = useState<DirectoryContact[]>([])
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [revision, setRevision] = useState(0)
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft)
  const fields = (bot.capabilities?.directory_fields || []).filter((key): key is 'directory_corp_id' | 'directory_agent_id' | 'directory_secret' => ['directory_corp_id', 'directory_agent_id', 'directory_secret'].includes(key))
  const valid = !draft.directory_enabled || fields.every(key => key === 'directory_secret'
    ? hasSecret || draft.directory_secret.trim() : !!String(draft[key]).trim())
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  useEffect(() => {
    if (!initial.directory_enabled || !bot.enabled) { setContacts([]); setStatus(null); return }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let loaded = ''
    const poll = async () => {
      try {
        const value = await channelBotApi.directoryStatus(bot.id, controller.signal)
        if (controller.signal.aborted) return
        setStatus(value)
        if (value.count && loaded !== value.updated_at) {
          const result = await channelBotApi.contacts(bot.id, query, offset, controller.signal)
          if (controller.signal.aborted) return
          loaded = value.updated_at || ''
          setContacts(result.contacts); setTotal(result.total)
        } else if (!value.count) { setContacts([]); setTotal(0) }
        if (value.status === 'loading') timer = setTimeout(() => void poll(), 1000)
      } catch (reason) { if (!controller.signal.aborted) setError(String(reason)) }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [bot.id, bot.enabled, initial.directory_enabled, query, offset, revision])
  const save = async () => {
    setBusy(true); setError('')
    try {
      const saved = await channelBotApi.update(bot.id, { ...draft, directory_secret: draft.directory_secret || undefined })
      const next = { ...draft, directory_secret: '' }
      setInitial(next); setDraft(next); setHasSecret(saved.has_directory_secret); setRevision(value => value + 1)
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const refresh = async () => {
    setBusy(true); setError('')
    try { setStatus(await channelBotApi.refreshDirectory(bot.id)); setRevision(value => value + 1) }
    catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <section className="bot-directory" aria-label={t('channelDirectory.title')}>
    <h3>{t('channelDirectory.title')}</h3>
    <label className="bot-settings-checkbox"><input type="checkbox" checked={draft.directory_enabled} disabled={busy}
      onChange={event => setDraft(value => ({ ...value, directory_enabled: event.target.checked }))} />{t('channelDirectory.enabled')}</label>
    <p className="bot-settings-hint">{t('channelDirectory.memoryHint')}</p>
    {draft.directory_enabled && fields.length > 0 && <div className="bot-settings-form">
      {fields.map(key => <label key={key}>{t(`channelDirectory.${key}`)}<Input type={key === 'directory_secret' ? 'password' : 'text'}
        autoComplete="off" disabled={busy} value={String(draft[key as keyof typeof draft] || '')}
        placeholder={key === 'directory_secret' && hasSecret ? t('channelBot.keepSecret') : ''}
        onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} /></label>)}
      <p className="bot-settings-hint">{t('channelDirectory.identityHint')}</p>
    </div>}
    {dirty && <Button disabled={!valid || busy} loading={busy} onClick={() => void save()}>{t('channelDirectory.save')}</Button>}
    {initial.directory_enabled && <>
      <div className="bot-directory-toolbar">
        <span role="status">{status?.status === 'loading' && <Spinner />}{!bot.enabled ? t('channelDirectory.botDisabled') :
          status?.status === 'loading' ? t('channelDirectory.loading') : t('channelDirectory.count', { count: status?.count || 0 })}</span>
        <Button disabled={dirty || busy || !bot.enabled || status?.status === 'loading'} onClick={() => void refresh()}>{t('channelDirectory.refresh')}</Button>
      </div>
      {status?.updated_at && <p className="bot-settings-hint">{t('channelDirectory.updated')}{new Date(status.updated_at).toLocaleString()}</p>}
      {status?.error && <p role="alert" className="bot-settings-error">{status.error}</p>}
      <Input aria-label={t('channelDirectory.search')} placeholder={t('channelDirectory.search')} value={query}
        onChange={event => { setQuery(event.target.value); setOffset(0) }} />
      <div className="bot-directory-table"><table><thead><tr><th>{t('channelDirectory.name')}</th><th>{t('channelDirectory.department')}</th><th>{t('channelDirectory.userId')}</th></tr></thead>
        <tbody>{contacts.map(row => <tr key={row.contact_id}><td>{row.name}</td><td>{row.departments.join(' / ')}</td><td><code>{row.contact_id}</code>{!row.user_id && <small>{t('channelDirectory.unverified')}</small>}</td></tr>)}</tbody></table></div>
      {!contacts.length && status?.status !== 'loading' && <p className="bot-settings-hint">{t('channelDirectory.empty')}</p>}
      {total > 50 && <div className="bot-directory-pagination"><Button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>{t('channelDirectory.previous')}</Button><span>{offset + 1}–{Math.min(offset + 50, total)} / {total}</span><Button disabled={offset + 50 >= total} onClick={() => setOffset(value => value + 50)}>{t('channelDirectory.next')}</Button></div>}
    </>}
    {error && <p role="alert" className="bot-settings-error">{error}</p>}
  </section>
}
