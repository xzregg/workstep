import { useState } from 'react'
import { channelBotApi, type PrivateWhitelist } from '../api/channelBots'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import './BotPrivateWhitelist.css'

export default function BotPrivateWhitelist({ botId, scope = 'private' }: { botId: string; scope?: 'private' | 'group' }) {
  const { t } = useI18n()
  const group = scope === 'group'
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PrivateWhitelist | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const query = search.trim().toLocaleLowerCase()
  const visibleUsers = state?.candidates.filter(user => `${user.sender_name} ${user.sender_id}`.toLocaleLowerCase().includes(query)) || []
  const dirty = !!state && (enabled !== state.enabled || JSON.stringify([...selected].sort()) !== JSON.stringify(state.users.map(user => user.sender_id).sort()))
  const load = async (initial: boolean) => {
    setBusy(true); setError('')
    try {
      const value = await (group ? channelBotApi.groupWhitelist : channelBotApi.privateWhitelist)(botId)
      setState(value)
      if (initial) { setEnabled(value.enabled); setSelected(value.users.map(user => user.sender_id)) }
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else setOpen(false) }
  const save = async () => {
    if (!state || busy) return
    setBusy(true); setError('')
    try {
      await (group ? channelBotApi.saveGroupWhitelist : channelBotApi.savePrivateWhitelist)(botId, { enabled, users: state.candidates.filter(user => selected.includes(user.sender_id)) })
      setOpen(false)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="ghost" onClick={() => { setState(null); setSearch(''); setOpen(true); void load(true) }}>{t(group ? 'channelBot.groupWhitelist' : 'channelBot.whitelist')}</Button>
    <ConfirmDialog open={open} title={t(group ? 'channelBot.groupWhitelist' : 'channelBot.whitelist')} message={t(group ? 'channelBot.groupWhitelistHint' : 'channelBot.whitelistHint')} width={560}
      confirmText={t('common.save')} loading={busy} confirmDisabled={!state || busy} onCancel={close} onConfirm={() => void save()}>
      <div className="bot-private-whitelist">
        <label><input type="checkbox" checked={enabled} disabled={!state || busy} onChange={event => setEnabled(event.target.checked)} />{t(group ? 'channelBot.groupWhitelistEnabled' : 'channelBot.whitelistEnabled')}</label>
        <Button variant="ghost" loading={busy} disabled={busy} onClick={() => void load(false)}>{t(group ? 'channelBot.groupWhitelistRefresh' : 'channelBot.whitelistRefresh')}</Button>
        <input className="bot-private-whitelist-search" type="search" value={search} placeholder={t(group ? 'channelBot.groupWhitelistSearch' : 'channelBot.whitelistSearch')} aria-label={t(group ? 'channelBot.groupWhitelistSearch' : 'channelBot.whitelistSearch')} onInput={event => setSearch(event.currentTarget.value)} />
        <div className="bot-private-whitelist-count" role="status">{t(group ? 'channelBot.groupWhitelistCount' : 'channelBot.whitelistCount', { selected: selected.length, total: state?.candidates.length || 0 })}</div>
        {error && <p role="alert">{error}</p>}
        {state && !state.candidates.length && <p>{t(group ? 'channelBot.groupWhitelistEmpty' : 'channelBot.whitelistEmpty')}</p>}
        {state && state.candidates.length > 0 && !visibleUsers.length && <p>{t(group ? 'channelBot.groupWhitelistNoMatch' : 'channelBot.whitelistNoMatch')}</p>}
        <div className="bot-private-whitelist-users">{visibleUsers.map(user => <label className="bot-private-whitelist-user" key={user.sender_id}>
          <input type="checkbox" checked={selected.includes(user.sender_id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...current, user.sender_id] : current.filter(id => id !== user.sender_id))} />
          <span>{user.sender_name || user.sender_id}<small>{user.sender_id}</small></span>
        </label>)}</div>
      </div>
    </ConfirmDialog>
    <ConfirmDialog open={discard} title={t(group ? 'channelBot.groupWhitelistDiscard' : 'channelBot.whitelistDiscard')} onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setOpen(false) }} />
  </>
}
