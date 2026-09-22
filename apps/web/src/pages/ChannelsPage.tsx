import { useEffect, useMemo, useState } from 'react'
import { assistantApi, fetchEngineModels, type AssistantConfigInfo, type EngineModel } from '../api/client'
import Button from '../components/Button'
import ChannelCard from '../components/ChannelCard'
import Field from '../components/Field'
import Select from '../components/Select'
import Spinner from '../components/Spinner'
import { useI18n } from '../i18n'
import type { TKey } from '../i18n'
import { useChannelStore } from '../stores/channelStore'
import { useProjectStore } from '../stores/projectStore'

export default function ChannelsPage() {
  const { t } = useI18n()
  const projectId = useProjectStore((state) => state.activeProject?.id)
  const { projectId: loadedProjectId, channels, login, loading, saving, error, load, update, startLogin, refreshLogin, logout } = useChannelStore()
  const [expanded, setExpanded] = useState(true)
  const [assistants, setAssistants] = useState<AssistantConfigInfo[]>([])
  const [models, setModels] = useState<EngineModel[]>([])
  const wechat = loadedProjectId === projectId
    ? channels.find((item) => item.channel_type === 'wechat')
    : undefined
  const selectedAssistant = useMemo(
    () => assistants.find((item) => item.name === wechat?.assistant_id),
    [assistants, wechat?.assistant_id],
  )
  const statusKey = `channels.status.${wechat?.status || 'not_logged_in'}` as TKey

  useEffect(() => {
    if (!projectId) return
    void load(projectId)
    void assistantApi.list().then((result) => setAssistants(result.assistants))
  }, [load, projectId])

  useEffect(() => {
    const engine = selectedAssistant?.configured.engine
    if (!projectId || !engine) {
      setModels([])
      return
    }
    void fetchEngineModels(
      engine,
      false,
      selectedAssistant.configured.provider_id,
      projectId,
    ).then((result) => setModels(result.models)).catch(() => setModels([]))
  }, [projectId, selectedAssistant])

  useEffect(() => {
    if (login?.status !== 'pending') return
    const timer = window.setInterval(() => void refreshLogin(), 2000)
    return () => window.clearInterval(timer)
  }, [login?.status, refreshLogin])

  if (loading && !wechat) {
    return <div className="channels-empty"><Spinner size={20} />{t('common.loading')}</div>
  }

  return (
    <main className="channels-page">
      <div className="channels-heading">
        <h1>{t('channels.title')}</h1>
        <p>{t('channels.subtitle')}</p>
      </div>
      {error && <div className="channels-error" role="alert">{error}</div>}
      {wechat && (
        <ChannelCard
          name={t('channels.wechat')}
          description={t('channels.wechatDescription')}
          status={wechat.status}
          statusLabel={t(statusKey)}
          enabled={wechat.enabled}
          enableDisabled={saving || wechat.status !== 'logged_in'}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((value) => !value)}
          onToggleEnabled={(enabled) => void update(wechat.id, {
            enabled,
            assistantId: wechat.assistant_id,
            model: wechat.model,
          })}
        >
          <div className="channel-fields">
            <Field label={t('channels.accountId')} help={wechat.status !== 'logged_in' ? t('channels.loginFirst') : undefined}>
              <div className="channel-account-row">
                <span>{wechat.account_id || t('channels.notBound')}</span>
                {wechat.status === 'logged_in' ? (
                  <Button onClick={() => void logout()} disabled={saving}>{t('channels.logout')}</Button>
                ) : (
                  <Button variant="primary" loading={saving} onClick={() => void startLogin()}>{t('channels.scanLogin')}</Button>
                )}
              </div>
            </Field>
            <Field label={t('channels.assistant')}>
              <Select
                value={wechat.assistant_id}
                disabled={saving}
                onChange={(event) => void update(wechat.id, {
                  enabled: wechat.enabled,
                  assistantId: event.target.value,
                  model: '',
                })}
              >
                {assistants.map((assistant) => (
                  <option key={assistant.name} value={assistant.name}>
                    {assistant.name === 'channel_chat' ? t('channels.channelAssistant') : assistant.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('channels.model')}>
              <Select
                value={wechat.model}
                disabled={saving}
                onChange={(event) => void update(wechat.id, {
                  enabled: wechat.enabled,
                  assistantId: wechat.assistant_id,
                  model: event.target.value,
                })}
              >
                <option value="">{t('channels.defaultModel')}</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </Select>
            </Field>
          </div>
          {(login?.status === 'pending' || login?.status === 'failed' || login?.qr_code) && (
            <div className="channel-qr-panel">
              {login.qr_code ? (
                <img src={login.qr_code} alt={t('channels.qrAlt')} />
              ) : login.status === 'failed' ? (
                <span className="channel-qr-failed-icon" aria-hidden>!</span>
              ) : (
                <Spinner size={22} />
              )}
              <span>{login.status === 'failed' ? t('channels.qrFailed') : t('channels.qrHint')}</span>
              {login.status === 'failed' && login.error && (
                <span className="channel-qr-error">{login.error}</span>
              )}
            </div>
          )}
        </ChannelCard>
      )}
    </main>
  )
}
