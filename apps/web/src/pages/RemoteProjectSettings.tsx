import { useCallback, useEffect, useState } from 'react'
import Button from '../components/Button'
import Field from '../components/Field'
import Input from '../components/Input'
import {
  remoteProjectApi,
  type RemoteAccessSettings,
  type RemoteDevice,
} from '../api/client'
import { useI18n } from '../i18n'

const EMPTY_SETTINGS: RemoteAccessSettings = {
  enabled: false,
  internal_base_url: '',
  external_base_url: '',
  host_id: '',
}

export default function RemoteProjectSettings() {
  const { t } = useI18n()
  const [settings, setSettings] = useState<RemoteAccessSettings>(EMPTY_SETTINGS)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const refreshDevices = useCallback(async () => {
    try {
      const result = await remoteProjectApi.devices()
      setDevices(result.devices)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.remoteLoadFailed'))
    }
  }, [t])

  useEffect(() => {
    let active = true
    void Promise.all([remoteProjectApi.settings(), remoteProjectApi.devices()])
      .then(([remoteSettings, remoteDevices]) => {
        if (!active) return
        setSettings(remoteSettings)
        setDevices(remoteDevices.devices)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : t('settings.remoteLoadFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    const timer = window.setInterval(() => { void refreshDevices() }, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refreshDevices, t])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const result = await remoteProjectApi.updateSettings({
        enabled: settings.enabled,
        internal_base_url: settings.internal_base_url,
        external_base_url: settings.external_base_url,
      })
      setSettings(result)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.remoteSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleRevoke = async (device: RemoteDevice) => {
    setError('')
    try {
      await remoteProjectApi.revokeDevice(device.project_id, device.device_id)
      setDevices((current) => current.map((item) => (
        item.project_id === device.project_id && item.device_id === device.device_id
          ? { ...item, revoked: true, connected: false }
          : item
      )))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.remoteRevokeFailed'))
    }
  }

  const authorizedDevices = devices.filter((device) => !device.revoked)

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <section style={{ paddingBottom: 24, borderBottom: '1px solid var(--border-soft)' }}>
        <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('settings.remoteAccessTitle')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>{t('settings.remoteAccessIntro')}</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={loading}
            style={{ width: 16, height: 16, padding: 0, margin: 0, flex: '0 0 auto' }}
            onChange={(event) => {
              setSettings((current) => ({ ...current, enabled: event.target.checked }))
              setSaved(false)
            }}
          />
          {t('settings.remoteAccessEnabled')}
        </label>
        <Field label={t('settings.internalAddress')} help={t('settings.internalAddressHint')}>
          <Input
            value={settings.internal_base_url}
            disabled={loading}
            onChange={(event) => {
              setSettings((current) => ({ ...current, internal_base_url: event.target.value }))
              setSaved(false)
            }}
            placeholder="http://192.168.1.20:8765"
          />
        </Field>
        <Field label={t('settings.externalAddress')}>
          <Input
            value={settings.external_base_url}
            disabled={loading}
            onChange={(event) => {
              setSettings((current) => ({ ...current, external_base_url: event.target.value }))
              setSaved(false)
            }}
            placeholder="https://workstep.example.com"
          />
        </Field>
        <p style={{ color: 'var(--muted)', fontSize: 11, margin: '4px 0 12px' }}>{t('settings.externalAddressHint')}</p>
        <Button variant="primary" loading={saving} disabled={loading} onClick={() => void handleSave()}>
          {t('common.save')}
        </Button>
        {saved && <span role="status" style={{ marginLeft: 8, color: 'var(--success)', fontSize: 11 }}>{t('settings.remoteSaved')}</span>}
        {error && <div role="status" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
      </section>

      <section style={{ paddingTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 650 }}>{t('settings.authorizedDevices')}</h2>
          <span style={{ color: 'var(--muted)', fontSize: 11 }}>
            {t('layout.remoteDevices', { count: authorizedDevices.filter((device) => device.connected).length })}
          </span>
        </div>
        {authorizedDevices.length === 0 ? (
          <div style={{ padding: '18px 0', color: 'var(--meta)', fontSize: 12 }}>{t('settings.noAuthorizedDevices')}</div>
        ) : authorizedDevices.map((device) => (
          <div
            key={`${device.project_id}:${device.device_id}`}
            style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 40, borderTop: '1px solid var(--border-soft)', fontSize: 12 }}
          >
            <span style={{ color: device.connected ? 'var(--success)' : 'var(--meta)' }}>{device.connected ? '●' : '○'}</span>
            <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{device.user_name || t('common.unknown')}</span>
            <span style={{ flex: 1, color: 'var(--muted)' }}>{device.device_name}</span>
            <Button variant="ghost" size="sm" onClick={() => void handleRevoke(device)}>{t('settings.revokeDevice')}</Button>
          </div>
        ))}
      </section>
    </div>
  )
}
