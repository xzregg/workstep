import { useEffect, useRef, useState } from 'react'
import { QRCode } from 'antd'
import { channelBotApi, type WeixinLogin } from '../api/channelBots'
import { useI18n } from '../i18n'
import Button from './Button'
import Spinner from './Spinner'

export default function WeixinLoginPanel({ botId, disabled, onAuthorized, onActiveChange }: {
  botId?: string
  disabled?: boolean
  onAuthorized: (loginId: string, accountId: string) => void
  onActiveChange: (active: boolean) => void
}) {
  const { t } = useI18n()
  const [login, setLogin] = useState<WeixinLogin | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const receipt = useRef('')
  const callbacks = useRef({ onAuthorized, onActiveChange })
  callbacks.current = { onAuthorized, onActiveChange }
  const cancel = () => {
    if (receipt.current) void channelBotApi.cancelWeixinLogin(receipt.current).catch(() => {})
    receipt.current = ''
  }
  useEffect(() => () => { generation.current++; cancel() }, [])

  const start = async () => {
    const current = ++generation.current
    cancel(); setLogin(null); setError(''); setLoading(true)
    callbacks.current.onAuthorized('', '')
    callbacks.current.onActiveChange(true)
    try {
      const next = await channelBotApi.startWeixinLogin(botId)
      if (current !== generation.current) {
        void channelBotApi.cancelWeixinLogin(next.login_id).catch(() => {})
        return
      }
      receipt.current = next.login_id
      setLogin(next)
    } catch (reason) {
      if (current === generation.current) setError(String(reason))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }

  const loginId = login?.login_id
  useEffect(() => {
    if (!loginId) return
    let active = true, timer: number | undefined
    const current = generation.current
    const controller = new AbortController()
    const poll = async () => {
      try {
        const next = await channelBotApi.pollWeixinLogin(loginId, controller.signal)
        if (!active || current !== generation.current) return
        setLogin(next)
        if (next.status === 'confirmed') {
          callbacks.current.onAuthorized(next.login_id, next.account_id)
        } else if (next.status !== 'expired') {
          timer = window.setTimeout(() => void poll(), 1000)
        }
      } catch (reason) {
        if (active && current === generation.current) setError(String(reason))
      }
    }
    void poll()
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [loginId])

  const waiting = !!login && ['wait', 'scaned'].includes(login.status) && !error
  return <div className="weixin-login-panel">
    <p className="bot-settings-hint">{t('channelBot.weixinScanHint')}</p>
    {waiting && <div className="weixin-login-code" role="img" aria-label={t('channelBot.weixinQrLabel')}>
      <QRCode type="svg" value={login.qr_content} size={200} color="#000000" bgColor="#ffffff" bordered={false} />
    </div>}
    <p className="weixin-login-status" role="status">
      {loading && <Spinner size={14} />}
      {loading ? t('common.loading') : login ? t(`channelBot.weixinLogin.${login.status}`) : botId ? t('channelBot.weixinStored') : t('channelBot.weixinNotLinked')}
    </p>
    {error && <p role="alert" className="bot-settings-error">{error}</p>}
    <div className="bot-settings-actions">
      <Button disabled={disabled} loading={loading} onClick={() => void start()}>{t(login || error ? 'channelBot.weixinRefresh' : botId ? 'channelBot.weixinRelogin' : 'channelBot.weixinConnect')}</Button>
      {(login || loading) && <Button disabled={disabled || loading} onClick={() => {
        generation.current++; cancel(); setLogin(null); setError('')
        callbacks.current.onAuthorized('', ''); callbacks.current.onActiveChange(false)
      }}>{t('channelBot.weixinCancelScan')}</Button>}
    </div>
  </div>
}
