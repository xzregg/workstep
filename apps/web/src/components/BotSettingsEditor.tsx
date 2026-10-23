import { useEffect, useState } from 'react'
import { BOT_PLATFORMS, channelBotApi, type BotDraft, type BotPlatform, type ChannelBot } from '../api/channelBots'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'

const consoles: Record<BotPlatform, string> = {
  wecom: 'https://work.weixin.qq.com/', dingtalk: 'https://open-dev.dingtalk.com/',
  feishu: 'https://open.feishu.cn/app', lark: 'https://open.larksuite.com/app',
  telegram: 'https://t.me/BotFather', discord: 'https://discord.com/developers/applications',
  slack: 'https://api.slack.com/apps',
}

export default function BotSettingsEditor({ platform, bot, onPlatformChange, onSaved, onCancel, onDirtyChange, onBusyChange }: {
  platform: BotPlatform
  bot?: ChannelBot
  onPlatformChange: (platform: BotPlatform) => void
  onSaved: () => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
}) {
  const { t } = useI18n()
  const projects = useProjectStore(state => state.projects)
  const localProjects = projects.filter(project => project.type !== 'remote')
  const [initial] = useState<BotDraft>(() => ({
    platform, name: bot?.name || '', app_id: bot?.app_id || '', secret: '', enabled: bot?.enabled || false,
    default_target_type: 'project', default_project_id: bot?.default_project_id || '', default_task_id: '',
    ...(platform === 'dingtalk' && bot ? { card_template_id: bot.card_template_id || '', review_card_template_id: bot.review_card_template_id || '' } : {}),
    ...(platform === 'slack' ? { app_token: '' } : {}),
  }))
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const setField = <K extends keyof BotDraft>(key: K, value: BotDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const valid = !!(draft.name.trim()
    && (platform === 'telegram' ? (draft.secret ? /^\d+:.+/.test(draft.secret.trim()) : bot?.has_secret) : draft.app_id.trim())
    && (bot?.has_secret || draft.secret.trim())
    && (platform !== 'slack' || bot?.has_app_token || draft.app_token?.trim())
    && localProjects.some(project => project.id === draft.default_project_id))
  const save = async () => {
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      const values: Partial<BotDraft> = { ...draft, secret: draft.secret.trim() }
      if (values.app_token !== undefined) values.app_token = values.app_token.trim()
      if (platform === 'telegram' && draft.secret) values.app_id = draft.secret.trim().split(':')[0]
      if (bot) {
        if (!values.secret) delete values.secret
        if (!values.app_token) delete values.app_token
        await channelBotApi.update(bot.id, values)
      } else {
        await channelBotApi.create(values as BotDraft)
      }
      onSaved()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }
  const appLabel = platform === 'wecom' ? 'Bot ID' : platform === 'dingtalk' ? 'Client ID' : platform === 'discord' ? 'Application ID' : 'App ID'
  const secretLabel = platform === 'wecom' ? 'Secret' : platform === 'dingtalk' ? 'Client Secret' : platform === 'telegram' || platform === 'discord' ? 'Bot Token' : platform === 'slack' ? 'Bot Token (xoxb-)' : 'App Secret'
  const hintKey = platform === 'lark' ? 'feishu' : platform
  return <section className="bot-settings-editor" aria-label={bot ? t('channelBot.edit') : t('channelBot.add')}>
    <header className="bot-settings-section-heading"><h2>{bot ? t('channelBot.edit') : t('channelBot.add')}</h2></header>
    <fieldset className="bot-settings-fieldset" disabled={busy}>
      <div className="bot-settings-form">
        <label>{t('channelBot.platform')}<Select value={platform} disabled={!!bot} onChange={event => onPlatformChange(event.target.value as BotPlatform)}>
          {BOT_PLATFORMS.map(value => <option key={value} value={value}>{t(`channelBot.${value}`)}</option>)}
        </Select></label>
        <label>{t('channelBot.name')}<Input autoComplete="off" value={draft.name} onChange={event => setField('name', event.target.value)} /></label>
        {platform !== 'telegram' && <label>{appLabel}<Input autoComplete="off" value={draft.app_id} onChange={event => setField('app_id', event.target.value)} /></label>}
        <label>{secretLabel}<Input type="password" autoComplete="new-password" value={draft.secret} placeholder={bot ? t('channelBot.keepSecret') : ''} onChange={event => setField('secret', event.target.value)} /></label>
        {platform === 'slack' && <label>App-Level Token (xapp-)<Input type="password" autoComplete="new-password" value={draft.app_token || ''} placeholder={bot?.has_app_token ? t('channelBot.keepSecret') : ''} onChange={event => setField('app_token', event.target.value)} /></label>}
        {platform === 'dingtalk' && <>
          <label>{t('channelBot.cardTemplate')}<Input value={draft.card_template_id || ''} placeholder={t('channelBot.cardTemplatePlaceholder')} onChange={event => setField('card_template_id', event.target.value)} /></label>
          <label>{t('channelBot.reviewCardTemplate')}<Input value={draft.review_card_template_id || ''} placeholder={t('channelBot.reviewCardTemplatePlaceholder')} onChange={event => setField('review_card_template_id', event.target.value)} /></label>
        </>}
        <label>{t('channelBot.defaultProject')}<Select required value={draft.default_project_id} onChange={event => setField('default_project_id', event.target.value)}>
          <option value="">{t('channelBot.selectProject')}</option>{localProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </Select></label>
        <label className="bot-settings-checkbox"><input type="checkbox" checked={draft.enabled} onChange={event => setField('enabled', event.target.checked)} />{t('channelBot.enabled')}</label>
      </div>
    </fieldset>
    <div className="bot-settings-guidance">
      <p className="bot-settings-hint">{t(`channelBot.${hintKey}Hint`)}</p>
      {['telegram', 'discord', 'slack'].includes(platform) && <p className="bot-settings-hint">{t('channelBot.textOnlyHint')}</p>}
      {platform === 'dingtalk' && <>
        <p className="bot-settings-hint">{t('channelBot.cardTemplateHint')}</p>
        <p className="bot-settings-hint">{t('channelBot.reviewCardTemplateHint')}</p>
      </>}
      <div className="bot-settings-help-links">
        <a href={consoles[platform]} target="_blank" rel="noopener noreferrer">{t(platform === 'dingtalk' ? 'channelBot.dingtalkConsole' : platform === 'feishu' ? 'channelBot.feishuConsole' : platform === 'lark' ? 'channelBot.larkConsole' : 'channelBot.openConsole')}</a>
        {platform === 'dingtalk' && <a href="https://open.dingtalk.com/document/orgapp/create-and-deliver-cards" target="_blank" rel="noopener noreferrer">{t('channelBot.cardPermissionDocs')}</a>}
      </div>
    </div>
    <p className="bot-settings-hint">{localProjects.length ? t('channelBot.defaultProjectHint') : t('channelBot.noLocalProject')}</p>
    <p className="bot-settings-hint">{t('channelBot.taskBindingHint')}</p>
    {error && <p className="bot-settings-error" role="alert">{error}</p>}
    <div className="bot-settings-actions"><Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>{t('common.save')}</Button>{(bot || dirty) && <Button disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>}</div>
  </section>
}
