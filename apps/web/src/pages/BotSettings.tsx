import { useEffect, useState } from 'react'
import { BOT_PLATFORMS, channelBotApi, type ChannelBot, type BotPlatform } from '../api/channelBots'
import Button from '../components/Button'
import BotSettingsEditor from '../components/BotSettingsEditor'
import BotPrivateWhitelist from '../components/BotPrivateWhitelist'
import BotTaskBindings from '../components/BotTaskBindings'
import ConfirmDialog from '../components/ConfirmDialog'
import Spinner from '../components/Spinner'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import './BotSettings.css'

const initials: Record<BotPlatform, string> = { wecom: '企', dingtalk: '钉', feishu: '飞', lark: 'L', telegram: 'T', discord: 'D', slack: 'S', qq: 'Q' }

export default function BotSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { t } = useI18n()
  const fetchProjects = useProjectStore(state => state.fetchProjects)
  const [bots, setBots] = useState<ChannelBot[]>([])
  const [platform, setPlatform] = useState<BotPlatform>('wecom')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editorVersion, setEditorVersion] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [busy, setBusy] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const reload = async () => setBots(await channelBotApi.list())
  useEffect(() => {
    let active = true, inFlight = false
    void fetchProjects()
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const rows = await channelBotApi.list()
        if (active) { setBots(rows); setError('') }
      } catch (reason) {
        if (active) setError(String(reason))
      } finally {
        inFlight = false
        if (active) setLoading(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [fetchProjects])

  const reset = () => { setEditingId(null); setDirty(false); setEditorVersion(value => value + 1) }
  const change = (action: () => void) => { if (dirty) setPending(() => action); else action() }
  const selectPlatform = (value: BotPlatform) => {
    if (value !== platform) change(() => { setPlatform(value); reset() })
  }
  const saved = () => { reset(); void reload().catch(reason => setError(String(reason))) }
  const remove = async () => {
    if (!deleteId) return
    setBusy(true); setError('')
    try {
      await channelBotApi.remove(deleteId)
      if (editingId === deleteId) reset()
      setDeleteId(null)
      await reload()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }
  const platformBots = bots.filter(bot => bot.platform === platform)
  return <div className="bot-settings">
    <header className="bot-settings-heading"><h1>{t('channelBot.title')}</h1><p>{t('channelBot.intro')}</p></header>
    <div className="bot-settings-workspace">
      <nav className="bot-settings-platforms" aria-label={t('channelBot.platform')}>
        {BOT_PLATFORMS.map(value => {
          const rows = bots.filter(bot => bot.platform === value)
          return <button key={value} type="button" className="bot-settings-platform" data-platform={value} disabled={busy || editorBusy} aria-pressed={platform === value} onClick={() => selectPlatform(value)}>
            <span className="bot-settings-platform-icon" aria-hidden="true">{initials[value]}</span>
            <span>{t(`channelBot.${value}`)}</span>
            <span className="bot-settings-platform-count">{rows.length || ''}</span>
            {rows.some(bot => bot.status === 'connected') && <span className="bot-settings-connected-dot" aria-label={t('channelBot.status.connected')} />}
          </button>
        })}
      </nav>
      <div className="bot-settings-content">
        <header className="bot-settings-section-heading"><h2>{t(`channelBot.${platform}`)}</h2><span>{t('channelBot.botCount', { count: platformBots.length })}</span></header>
        {loading && <div className="bot-settings-loading" role="status"><Spinner />{t('common.loading')}</div>}
        {error && <p className="bot-settings-error" role="alert">{error}<Button onClick={() => void reload().then(() => setError('')).catch(reason => setError(String(reason)))}>{t('common.retry')}</Button></p>}
        <div className="bot-settings-list">
          {platformBots.map(bot => <div className="bot-settings-card" key={bot.id}>
            <div className="bot-settings-row"><div><strong>{bot.name}</strong><span>{bot.app_id}</span></div>
              <span className="bot-settings-status" role="status" data-status={bot.status}>{['connecting', 'reconnecting'].includes(bot.status) && <Spinner size={12} />}{t(`channelBot.status.${bot.status}` as 'channelBot.status.connected')}{bot.error ? ` · ${bot.error}` : ''}</span>
            </div>
            <div className="bot-settings-card-actions">
              <BotPrivateWhitelist botId={bot.id} />
              <BotPrivateWhitelist botId={bot.id} scope="group" />
              <BotTaskBindings bindings={bot.task_bindings} onChanged={reload} />
              <Button disabled={busy || editorBusy} onClick={() => { if (bot.id !== editingId) change(() => { setEditingId(bot.id); setDirty(false) }) }}>{t('common.edit')}</Button>
              <Button disabled={busy || editorBusy} onClick={() => setDeleteId(bot.id)}>{t('common.delete')}</Button>
            </div>
          </div>)}
          {!loading && !error && !platformBots.length && <p className="bot-settings-empty">{t('channelBot.empty')}</p>}
        </div>
        {editingId && <div className="bot-settings-actions"><Button disabled={busy || editorBusy} onClick={() => change(reset)}>{t('channelBot.add')}</Button></div>}
        <BotSettingsEditor key={`${platform}:${editingId || 'new'}:${editorVersion}`} platform={platform} bot={bots.find(bot => bot.id === editingId)} onPlatformChange={selectPlatform} onSaved={saved} onCancel={() => change(reset)} onDirtyChange={setDirty} onBusyChange={setEditorBusy} />
      </div>
    </div>
    <ConfirmDialog open={!!deleteId} title={t('channelBot.deleteTitle')} message={t('channelBot.deleteHint')} danger loading={busy} onCancel={() => setDeleteId(null)} onConfirm={() => void remove()} />
    <ConfirmDialog open={!!pending} title={t('channelBot.discardConfig')} message={t('channelBot.discardConfigHint')} onCancel={() => setPending(null)} onConfirm={() => { pending?.(); setPending(null) }} />
  </div>
}
