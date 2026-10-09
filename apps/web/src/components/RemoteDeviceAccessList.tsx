import { useState } from 'react'
import { remoteProjectApi, type RemoteDevice } from '../api/client'
import { useI18n } from '../i18n'
import {
  resolveAccessExpiresAt,
  type AccessDurationPreset,
} from '../utils/remoteDeviceAccess'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Field from './Field'
import Input from './Input'
import Select from './Select'

interface Props {
  devices: RemoteDevice[]
  onDeviceChange: (device: RemoteDevice) => void
  onError: (message: string) => void
}

function inputDateTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export default function RemoteDeviceAccessList({ devices, onDeviceChange, onError }: Props) {
  const { t, locale } = useI18n()
  const authorizedDevices = devices.filter(device => !device.revoked && device.status !== 'revoked')
  const [editing, setEditing] = useState<RemoteDevice | null>(null)
  const [revoking, setRevoking] = useState<RemoteDevice | null>(null)
  const [preset, setPreset] = useState<AccessDurationPreset>('permanent')
  const [customExpiry, setCustomExpiry] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [saving, setSaving] = useState(false)

  const formatTime = (value: number) => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value * 1000))

  const openExpiry = (device: RemoteDevice) => {
    setEditing(device)
    setPreset(device.expires_at === null ? 'permanent' : 'custom')
    setCustomExpiry(device.expires_at === null ? '' : inputDateTime(device.expires_at))
    setDialogError('')
  }

  const saveExpiry = async () => {
    if (!editing || saving) return
    let expiresAt: number | null
    try {
      expiresAt = resolveAccessExpiresAt(preset, customExpiry)
    } catch {
      setDialogError(t('layout.expiryFutureRequired'))
      return
    }
    setSaving(true)
    setDialogError('')
    try {
      const result = await remoteProjectApi.updateDeviceAccess(
        editing.project_id,
        editing.device_id,
        expiresAt,
      )
      onDeviceChange(result.device)
      setEditing(null)
    } catch (reason) {
      setDialogError(
        reason instanceof Error ? reason.message : t('settings.remoteAccessUpdateFailed'),
      )
    } finally {
      setSaving(false)
    }
  }

  const revoke = async () => {
    if (!revoking || saving) return
    setSaving(true)
    onError('')
    try {
      await remoteProjectApi.revokeDevice(revoking.project_id, revoking.device_id)
      onDeviceChange({
        ...revoking,
        status: 'revoked',
        revoked: true,
        connected: false,
      })
      setRevoking(null)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t('settings.remoteRevokeFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (authorizedDevices.length === 0) {
    return (
      <div style={{ padding: '18px 0', color: 'var(--meta)', fontSize: 'calc(12px * var(--font-scale))' }}>
        {t('settings.noAuthorizedDevices')}
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'grid', gap: 0 }}>
        {authorizedDevices.map((device) => {
          const status = device.status ?? (device.revoked ? 'revoked' : 'active')
          const statusLabel = status === 'revoked'
            ? t('settings.deviceRevoked')
            : status === 'expired'
              ? t('settings.deviceExpired')
              : device.connected
                ? t('settings.deviceOnline')
                : t('settings.deviceOffline')
          const statusColor = status === 'revoked'
            ? 'var(--danger)'
            : status === 'expired'
              ? 'var(--status-paused)'
              : device.connected
                ? 'var(--success)'
                : 'var(--meta)'
          return (
            <div
              key={`${device.project_id}:${device.device_id}`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: '8px 14px',
                padding: '12px 0',
                borderTop: '1px solid var(--border-soft)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <span
                    aria-hidden="true"
                    style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: statusColor }}
                  />
                  <span style={{ color: 'var(--fg)', fontSize: 'calc(12px * var(--font-scale))', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {device.user_name || t('common.unknown')}
                  </span>
                  <span style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {device.device_name}
                  </span>
                  <span style={{ color: statusColor, fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0 }}>{statusLabel}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px', marginTop: 5, color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', lineHeight: 1.45 }}>
                  <span>
                    {device.expires_at === null
                      ? t('settings.accessPermanent')
                      : t('settings.accessUntil', { time: formatTime(device.expires_at) })}
                  </span>
                  {device.last_seen_at > 0 && (
                    <span>{t('settings.lastActive', { time: formatTime(device.last_seen_at) })}</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {status !== 'revoked' && (
                  <Button variant="ghost" size="sm" onClick={() => openExpiry(device)}>
                    {t('settings.changeAccess')}
                  </Button>
                )}
                {status !== 'revoked' && (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(device)} style={{ color: 'var(--danger)' }}>
                    {t('settings.revokeDevice')}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={editing !== null}
        title={t('settings.changeAccessTitle')}
        confirmText={t('settings.saveAccess')}
        loading={saving}
        onConfirm={() => void saveExpiry()}
        onCancel={() => { setEditing(null); setDialogError('') }}
      >
        <div style={{ marginTop: 14 }}>
          <Field label={t('layout.deviceAccessDuration')} error={dialogError}>
            <Select
              value={preset}
              onChange={(event) => { setPreset(event.target.value as AccessDurationPreset); setDialogError('') }}
              style={{ width: '100%' }}
            >
              <option value="permanent">{t('layout.accessPermanent')}</option>
              <option value="day">{t('layout.accessOneDay')}</option>
              <option value="week">{t('layout.accessSevenDays')}</option>
              <option value="month">{t('layout.accessThirtyDays')}</option>
              <option value="custom">{t('layout.accessCustom')}</option>
            </Select>
          </Field>
          {preset === 'custom' && (
            <Field label={t('layout.customExpiry')}>
              <Input
                type="datetime-local"
                value={customExpiry}
                onChange={(event) => { setCustomExpiry(event.target.value); setDialogError('') }}
              />
            </Field>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={revoking !== null}
        title={t('settings.revokeDeviceTitle')}
        message={t('settings.revokeDeviceMessage')}
        confirmText={t('settings.revokeDevice')}
        danger
        loading={saving}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </>
  )
}
