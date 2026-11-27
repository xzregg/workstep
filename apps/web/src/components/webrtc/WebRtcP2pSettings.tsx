import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { gatewayFetch } from '../../utils/gatewayWorkspacePath'
import { isGatewayRemoteBrowser } from '../../utils/gatewayRemote'
import { isWebRtcRemoteBrowser } from '../../webrtc/webrtcLocation'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import Field from '../Field'
import Icon from '../Icon'
import Input from '../Input'
import StatusBadge from '../StatusBadge'
import './WebRtcP2pSettings.css'

export interface WebRtcP2pSettingsData {
  enabled: boolean
  signal_url: string
  device_id: string
  device_name: string
  pair_key: string
  p2p_url: string
  online: boolean
  active_peers: number
  direct_only: boolean
  last_error: string
}

function isPrivateOrLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return true
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true
  const parts = host.split('.').map(Number)
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
  }
  return /^\[?(?:fc|fd)[0-9a-f:]+\]?$/i.test(host)
}

export function validSignalUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  try {
    const parsed = new URL(trimmed)
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      return false
    }
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isPrivateOrLoopbackHost(parsed.hostname))
  } catch {
    return false
  }
}

export default function WebRtcP2pSettings() {
  const { t } = useI18n()
  const remoteReadOnly = isGatewayRemoteBrowser() || isWebRtcRemoteBrowser()

  const [data, setData] = useState<WebRtcP2pSettingsData | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [signalUrl, setSignalUrl] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [loading, setLoading] = useState(!remoteReadOnly)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [copiedField, setCopiedField] = useState<'key' | 'url' | null>(null)
  const [error, setError] = useState('')

  const loadSettings = useCallback(async () => {
    if (remoteReadOnly) return
    setLoading(true)
    setError('')
    try {
      const response = await gatewayFetch('/api/webrtc-p2p/settings')
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(String((body as { detail?: string }).detail || `HTTP ${response.status}`))
      }
      const next = await response.json() as WebRtcP2pSettingsData
      setData(next)
      setEnabled(next.enabled)
      setSignalUrl(next.signal_url)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('webrtcP2p.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [remoteReadOnly, t])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  if (remoteReadOnly) {
    return (
      <section className="webrtc-p2p-settings webrtc-p2p-readonly">
        <div className="webrtc-p2p-header">
          <h1>{t('webrtcP2p.title')}</h1>
        </div>
        <p>{t('webrtcP2p.remoteReadOnly')}</p>
      </section>
    )
  }

  const urlValid = validSignalUrl(signalUrl) && (!enabled || Boolean(signalUrl.trim()))

  const saveSettings = async () => {
    if (!urlValid || saving) return
    setSaving(true)
    setError('')
    try {
      const response = await gatewayFetch('/api/webrtc-p2p/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          signal_url: signalUrl.trim().replace(/\/$/, ''),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(String((body as { detail?: string }).detail || `HTTP ${response.status}`))
      }
      const next = await response.json() as WebRtcP2pSettingsData
      setData(next)
      setEnabled(next.enabled)
      setSignalUrl(next.signal_url)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('webrtcP2p.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const rotateKey = async () => {
    setRotating(true)
    setError('')
    try {
      const response = await gatewayFetch('/api/webrtc-p2p/rotate-key', { method: 'POST' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(String((body as { detail?: string }).detail || `HTTP ${response.status}`))
      }
      const next = await response.json() as WebRtcP2pSettingsData
      setData(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('webrtcP2p.saveFailed'))
    } finally {
      setRotating(false)
      setConfirmRotate(false)
    }
  }

  const copyText = (text: string, field: 'key' | 'url') => {
    if (!text) return
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedField(field)
      window.setTimeout(() => setCopiedField((prev) => (prev === field ? null : prev)), 1500)
    }).catch(() => undefined)
  }

  const badgeStatus = data?.online ? 'completed' : data?.enabled ? 'running' : 'pending'
  const badgeLabel = data?.online
    ? t('webrtcP2p.statusOnline')
    : data?.enabled
      ? t('webrtcP2p.statusConnecting')
      : t('webrtcP2p.statusDisabled')

  return (
    <section className="webrtc-p2p-settings">
      <div className="webrtc-p2p-header">
        <h1>{t('webrtcP2p.title')}</h1>
        {data && <StatusBadge status={badgeStatus} label={badgeLabel} loading={data.enabled && !data.online} />}
        <Button
          size="sm"
          variant="ghost"
          loading={loading}
          aria-label={t('webrtcP2p.refresh')}
          onClick={() => void loadSettings()}
        >
          <Icon name="refresh" size={14} />
        </Button>
      </div>

      <form
        className="webrtc-p2p-form"
        onSubmit={(event) => {
          event.preventDefault()
          void saveSettings()
        }}
      >
        <label className="webrtc-p2p-toggle" htmlFor="webrtc-p2p-enabled">
          <input
            id="webrtc-p2p-enabled"
            type="checkbox"
            checked={enabled}
            disabled={loading || saving}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>{t('webrtcP2p.enable')}</span>
        </label>

        <Field
          label={t('webrtcP2p.signalUrl')}
          htmlFor="webrtc-signal-url"
          error={!urlValid ? t('webrtcP2p.invalidSignalUrl') : undefined}
          help={t('webrtcP2p.signalUrlHint')}
        >
          <Input
            id="webrtc-signal-url"
            type="url"
            value={signalUrl}
            disabled={loading || saving}
            placeholder="https://signal.example.com:8780"
            onChange={(event) => {
              setSignalUrl(event.target.value)
              setError('')
            }}
          />
        </Field>

        <Field label={t('webrtcP2p.pairKey')} htmlFor="webrtc-pair-key">
          <div className="webrtc-p2p-secret-row">
            <Input
              id="webrtc-pair-key"
              type={showKey ? 'text' : 'password'}
              readOnly
              value={data?.pair_key ?? ''}
              aria-label={t('webrtcP2p.pairKey')}
            />
            <Button
              type="button"
              variant="ghost"
              className="webrtc-p2p-icon-btn"
              data-testid="webrtc-pair-key-toggle"
              aria-label={t(showKey ? 'webrtcP2p.hideKey' : 'webrtcP2p.showKey')}
              onClick={() => setShowKey((prev) => !prev)}
            >
              <Icon name={showKey ? 'eye-off' : 'eye'} size={16} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="webrtc-p2p-icon-btn"
              aria-label={t('webrtcP2p.copyKey')}
              onClick={() => copyText(data?.pair_key ?? '', 'key')}
            >
              <Icon name={copiedField === 'key' ? 'check' : 'copy'} size={16} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="webrtc-rotate-btn"
              loading={rotating}
              disabled={loading || rotating}
              onClick={() => setConfirmRotate(true)}
            >
              {t('webrtcP2p.rotateKey')}
            </Button>
          </div>
        </Field>

        {data?.p2p_url && (
          <Field label={t('webrtcP2p.entryUrl')}>
            <div className="webrtc-p2p-link-row">
              <span className="webrtc-p2p-link-value" data-testid="webrtc-p2p-url">{data.p2p_url}</span>
              <Button
                type="button"
                variant="ghost"
                className="webrtc-p2p-icon-btn"
                aria-label={t('webrtcP2p.copyUrl')}
                onClick={() => copyText(data.p2p_url, 'url')}
              >
                <Icon name={copiedField === 'url' ? 'check' : 'copy'} size={16} />
              </Button>
            </div>
          </Field>
        )}

        {(error || data?.last_error) && (
          <p className="webrtc-p2p-feedback" role="alert">{error || data?.last_error}</p>
        )}

        <div className="webrtc-p2p-actions">
          <Button
            type="submit"
            variant="primary"
            data-testid="webrtc-save-btn"
            loading={saving}
            disabled={loading || saving || !urlValid}
          >
            {t('common.save')}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmRotate}
        title={t('webrtcP2p.rotateConfirmTitle')}
        message={t('webrtcP2p.rotateConfirmMessage')}
        danger
        loading={rotating}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() => void rotateKey()}
      />
    </section>
  )
}
