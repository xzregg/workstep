import { useCallback, useEffect, useState } from 'react'
import Button from '../components/Button'
import Field from '../components/Field'
import Input from '../components/Input'
import RemoteDeviceAccessList from '../components/RemoteDeviceAccessList'
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
  access_password_set: false,
}

export default function RemoteProjectSettings() {
  const { t } = useI18n()
  const [settings, setSettings] = useState<RemoteAccessSettings>(EMPTY_SETTINGS)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [passwordDraft, setPasswordDraft] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordSaved, setPasswordSaved] = useState(false)

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

  const savePassword = async (password: string) => {
    setPasswordSaving(true)
    setPasswordSaved(false)
    setError('')
    try {
      const result = await remoteProjectApi.updateSettings({
        enabled: settings.enabled,
        internal_base_url: settings.internal_base_url,
        external_base_url: settings.external_base_url,
        access_password: password,
      })
      setSettings(result)
      setPasswordDraft('')
      setPasswordSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.remoteSaveFailed'))
    } finally {
      setPasswordSaving(false)
    }
  }

  const handleDeviceChange = (device: RemoteDevice) => {
    setDevices((current) => current.map((item) => (
      item.project_id === device.project_id && item.device_id === device.device_id
        ? device
        : item
    )))
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <section style={{ paddingBottom: 24, borderBottom: '1px solid var(--border-soft)' }}>
        <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>{t('settings.remoteAccessTitle')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))', marginBottom: 18 }}>{t('settings.remoteAccessIntro')}</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', marginBottom: 16 }}>
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
        <p style={{ color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))', margin: '4px 0 12px' }}>{t('settings.externalAddressHint')}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Button variant="primary" loading={saving} disabled={loading} onClick={() => void handleSave()}>
            {t('common.save')}
          </Button>
          {saved && <span role="status" style={{ color: 'var(--success)', fontSize: 'calc(11px * var(--font-scale))' }}>{t('settings.remoteSaved')}</span>}
        </div>
        <div style={{ margin: '4px 0 14px', paddingTop: 12, borderTop: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{t('settings.accessPassword')}</div>
          <div style={{ color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))', marginTop: 2, marginBottom: 10 }}>
            {settings.access_password_set ? t('settings.accessPasswordSet') : t('settings.accessPasswordUnset')}
          </div>
          <Field label={t('settings.accessPassword')} help={t('settings.accessPasswordHint')}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input
                type="password"
                value={passwordDraft}
                disabled={loading}
                onChange={(event) => {
                  setPasswordDraft(event.target.value)
                  setPasswordSaved(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && passwordDraft.trim() && !passwordSaving) {
                    void savePassword(passwordDraft)
                  }
                }}
                placeholder={t('settings.accessPasswordPlaceholder')}
                maxLength={200}
              />
              <Button
                variant="primary"
                loading={passwordSaving}
                disabled={loading || !passwordDraft.trim()}
                onClick={() => void savePassword(passwordDraft)}
              >
                {t('settings.saveAccessPassword')}
              </Button>
              {settings.access_password_set && (
                <Button
                  variant="ghost"
                  disabled={loading || passwordSaving}
                  onClick={() => void savePassword('')}
                >
                  {t('settings.clearAccessPassword')}
                </Button>
              )}
            </div>
          </Field>
          {passwordSaved && (
            <div role="status" style={{ marginTop: 6, color: 'var(--success)', fontSize: 'calc(11px * var(--font-scale))' }}>
              {t('settings.accessPasswordSaved')}
            </div>
          )}
        </div>
        {error && <div role="status" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>{error}</div>}
      </section>

      <section style={{ paddingTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650 }}>{t('settings.authorizedDevices')}</h2>
          <span style={{ color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))' }}>
            {t('layout.remoteDevices', { count: devices.filter((device) => device.connected).length })}
          </span>
        </div>
        <RemoteDeviceAccessList
          devices={devices}
          onDeviceChange={handleDeviceChange}
          onError={setError}
        />
      </section>
    </div>
  )
}
