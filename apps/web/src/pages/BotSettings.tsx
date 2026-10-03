import { useEffect, useState } from 'react'
import { channelBotApi, type BotDraft, type ChannelBot, type BotPlatform, type BotTargetType } from '../api/channelBots'
import Button from '../components/Button'
import BotTaskBindings from '../components/BotTaskBindings'
import ConfirmDialog from '../components/ConfirmDialog'
import Input from '../components/Input'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import './BotSettings.css'

const emptyDraft = (): BotDraft => ({
  platform: 'wecom', name: '', app_id: '', secret: '', enabled: false,
  default_target_type: '', default_project_id: '', default_task_id: '',
})

export default function BotSettings() {
  const { t } = useI18n()
  const projects = useProjectStore((state) => state.projects)
  const fetchProjects = useProjectStore((state) => state.fetchProjects)
  const [bots, setBots] = useState<ChannelBot[]>([])
  const [draft, setDraft] = useState<BotDraft>(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const reload = async () => setBots(await channelBotApi.list())
  useEffect(() => {
    void fetchProjects()
    void reload().catch((reason) => setError(String(reason)))
    const timer = window.setInterval(() => {
      void channelBotApi.list().then(setBots).catch(() => undefined)
    }, 10000)
    return () => window.clearInterval(timer)
  }, [fetchProjects])

  const setField = <K extends keyof BotDraft>(key: K, value: BotDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }
  const edit = (bot: ChannelBot) => {
    setEditingId(bot.id)
    setDraft({
      platform: bot.platform, name: bot.name, app_id: bot.app_id, secret: '',
      enabled: bot.enabled, default_target_type: bot.default_target_type === 'task' ? 'project' : bot.default_target_type,
      default_project_id: bot.default_project_id, default_task_id: '',
      ...(bot.platform === 'dingtalk' ? { card_template_id: bot.card_template_id || '' } : {}),
    })
    setError('')
  }
  const reset = () => { setEditingId(null); setDraft(emptyDraft()); setError('') }
  const valid = draft.name.trim() && draft.app_id.trim() && (editingId || draft.secret.trim())
    && (draft.default_target_type === '' || draft.default_project_id)


  const save = async () => {
    if (!valid) return
    setBusy(true)
    setError('')
    try {
      if (editingId) {
        const values: Partial<BotDraft> = { ...draft }
        if (!values.secret) delete values.secret
        await channelBotApi.update(editingId, values)
      } else {
        await channelBotApi.create(draft)
      }
      await reload()
      reset()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!deleteId) return
    setBusy(true)
    try {
      await channelBotApi.remove(deleteId)
      await reload()
      if (editingId === deleteId) reset()
      setDeleteId(null)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return <div className="bot-settings">
    <h1>{t('channelBot.title')}</h1>
    <p>{t('channelBot.intro')}</p>
    <div className="bot-settings-list">
      {bots.map((bot) => <div className="bot-settings-card" key={bot.id}><div className="bot-settings-row">
        <div><strong>{bot.name}</strong><span>{bot.platform === 'wecom' ? t('channelBot.wecom') : t('channelBot.dingtalk')} · {bot.app_id}</span></div>
        <span role="status">{t(`channelBot.status.${bot.status}` as 'channelBot.status.connected')}{bot.error ? ` · ${bot.error}` : ''}</span>
        <Button variant="ghost" onClick={() => edit(bot)}>{t('common.edit')}</Button>
        <Button variant="ghost" onClick={() => setDeleteId(bot.id)}>{t('common.delete')}</Button>
      </div><BotTaskBindings bindings={bot.task_bindings} onChanged={reload} /></div>)}
      {!bots.length && <p>{t('channelBot.empty')}</p>}
    </div>
    <h2>{editingId ? t('channelBot.edit') : t('channelBot.add')}</h2>
    <div className="bot-settings-form">
      <label>{t('channelBot.platform')}<select value={draft.platform} disabled={!!editingId} onChange={(event) => setField('platform', event.target.value as BotPlatform)}>
        <option value="wecom">{t('channelBot.wecom')}</option><option value="dingtalk">{t('channelBot.dingtalk')}</option>
      </select></label>
      <label>{t('channelBot.name')}<Input value={draft.name} onChange={(event) => setField('name', event.target.value)} /></label>
      <label>{draft.platform === 'wecom' ? 'Bot ID' : 'Client ID'}<Input value={draft.app_id} onChange={(event) => setField('app_id', event.target.value)} /></label>
      <label>{draft.platform === 'wecom' ? 'Secret' : 'Client Secret'}<Input type="password" value={draft.secret} placeholder={editingId ? t('channelBot.keepSecret') : ''} onChange={(event) => setField('secret', event.target.value)} /></label>
      {draft.platform === 'dingtalk' && <label>{t('channelBot.cardTemplate')}<Input value={draft.card_template_id || ''} placeholder={t('channelBot.cardTemplatePlaceholder')} onChange={(event) => setField('card_template_id', event.target.value)} /></label>}
      <label>{t('channelBot.defaultTarget')}<select value={draft.default_target_type} onChange={(event) => setDraft((current) => ({ ...current, default_target_type: event.target.value as BotTargetType, default_project_id: '', default_task_id: '' }))}>
        <option value="">{t('channelBot.none')}</option><option value="project">{t('channelBot.project')}</option>
      </select></label>
      {draft.default_target_type && <label>{t('channelBot.project')}<select value={draft.default_project_id} onChange={(event) => setDraft((current) => ({ ...current, default_project_id: event.target.value, default_task_id: '' }))}>
        <option value="">{t('channelBot.selectProject')}</option>{projects.filter((project) => project.type !== 'remote').map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>}
      <label className="bot-settings-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setField('enabled', event.target.checked)} />{t('channelBot.enabled')}</label>
    </div>
    <p className="bot-settings-hint">{t('channelBot.taskBindingHint')}</p>
    {draft.platform === 'dingtalk' && <p className="bot-settings-hint">{t('channelBot.cardTemplateHint')}</p>}
    <p className="bot-settings-hint">{draft.platform === 'wecom' ? t('channelBot.wecomHint') : t('channelBot.dingtalkHint')}</p>
    {error && <p className="bot-settings-error" role="alert">{error}</p>}
    <div className="bot-settings-actions"><Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>{t('common.save')}</Button>{editingId && <Button variant="ghost" onClick={reset}>{t('common.cancel')}</Button>}</div>
    <ConfirmDialog open={!!deleteId} title={t('channelBot.deleteTitle')} message={t('channelBot.deleteHint')} danger loading={busy} onCancel={() => setDeleteId(null)} onConfirm={() => void remove()} />
  </div>
}
