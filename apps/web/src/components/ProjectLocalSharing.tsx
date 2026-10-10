import { useEffect, useState } from 'react'
import { remoteProjectApi, type RemoteDevice } from '../api/client'
import { useI18n } from '../i18n'
import { resolveAccessExpiresAt, type AccessDurationPreset } from '../utils/remoteDeviceAccess'
import { copyText } from '../utils/clipboard'
import Button from './Button'
import Field from './Field'
import Input from './Input'
import RemoteDeviceAccessList from './RemoteDeviceAccessList'
import Select from './Select'
import './ProjectLocalSharing.css'

export default function ProjectLocalSharing({ projectId, active = true }: { projectId: string; active?: boolean }) {
  const { t, locale } = useI18n()
  const [access, setAccess] = useState<'internal' | 'external'>('internal')
  const [accessDuration, setAccessDuration] = useState<AccessDurationPreset>('permanent')
  const [customExpiry, setCustomExpiry] = useState('')
  const [shareValue, setShareValue] = useState('')
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null)
  const [shareAccessExpiresAt, setShareAccessExpiresAt] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [deviceError, setDeviceError] = useState('')
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<RemoteDevice[]>([])

  useEffect(() => {
    setAccess('internal')
    setAccessDuration('permanent')
    setCustomExpiry('')
    setShareValue('')
    setInviteExpiresAt(null)
    setShareAccessExpiresAt(null)
    setError('')
    setDeviceError('')
    setDevices([])
  }, [projectId])

  useEffect(() => {
    if (!projectId || !active) return
    let mounted = true
    let refreshing = false
    const refresh = () => {
      if (refreshing) return
      refreshing = true
      void remoteProjectApi.devices(projectId).then(result => {
        if (mounted) setDevices(result.devices)
      }).catch(() => undefined).finally(() => { refreshing = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [projectId, active])

  const createShare = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const accessExpiresAt = resolveAccessExpiresAt(accessDuration, customExpiry)
      const result = await remoteProjectApi.createShare(projectId, access, accessExpiresAt)
      setShareValue(result.share_string)
      setInviteExpiresAt(result.expires_at)
      setShareAccessExpiresAt(result.access_expires_at)
    } catch (reason) {
      setError(accessDuration === 'custom' && (!customExpiry || new Date(customExpiry).getTime() <= Date.now())
        ? t('layout.expiryFutureRequired') : reason instanceof Error ? reason.message : t('layout.remoteShareFailed'))
    } finally { setLoading(false) }
  }

  const changeAccess = (next: 'internal' | 'external') => {
    setAccess(next); setShareValue(''); setInviteExpiresAt(null); setError('')
  }
  const formatTime = (value: number) => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value * 1000))
  const handleDeviceChange = (device: RemoteDevice) => {
    setDevices(current => current.map(item => item.project_id === device.project_id && item.device_id === device.device_id ? device : item))
  }

  return <div className="project-local-sharing">
          <Field label={t('layout.accessType')}>
            <div className="project-local-sharing-networks">
              <Button variant={access === 'internal' ? 'primary' : 'ghost'} onClick={() => changeAccess('internal')}>
                {t('layout.internalAccess')}
              </Button>
              <Button variant={access === 'external' ? 'primary' : 'ghost'} onClick={() => changeAccess('external')}>
                {t('layout.externalAccess')}
              </Button>
            </div>
          </Field>
          <p className="project-local-sharing-hint">
            {access === 'external' ? t('layout.externalAccessHint') : t('layout.internalAccessHint')}
          </p>
          <Field label={t('layout.deviceAccessDuration')} error={error || undefined}>
            <Select
              value={accessDuration}
              onChange={(event) => {
                setAccessDuration(event.target.value as AccessDurationPreset)
                setShareValue('')
                setInviteExpiresAt(null)
                setError('')
              }}
            >
              <option value="permanent">{t('layout.accessPermanent')}</option>
              <option value="day">{t('layout.accessOneDay')}</option>
              <option value="week">{t('layout.accessSevenDays')}</option>
              <option value="month">{t('layout.accessThirtyDays')}</option>
              <option value="custom">{t('layout.accessCustom')}</option>
            </Select>
          </Field>
          {accessDuration === 'custom' && (
            <Field label={t('layout.customExpiry')}>
              <Input
                type="datetime-local"
                value={customExpiry}
                onChange={(event) => { setCustomExpiry(event.target.value); setShareValue(''); setError('') }}
              />
            </Field>
          )}
          {shareValue && (
            <Field label={t('layout.remoteShareString')}>
              <textarea
                readOnly
                value={shareValue}
                rows={6}
                className="project-local-sharing-string"
              />
              <div className="project-local-sharing-expiry">
                {inviteExpiresAt !== null && (
                  <span>{t('layout.inviteExpiresAt', { time: formatTime(inviteExpiresAt) })}</span>
                )}
                <span>
                  {shareAccessExpiresAt === null
                    ? t('layout.deviceAccessPermanent')
                    : t('layout.deviceAccessUntil', { time: formatTime(shareAccessExpiresAt) })}
                </span>
              </div>
            </Field>
          )}
          <div className="project-local-sharing-devices">
            <div className="project-local-sharing-device-title">
              {t('layout.remoteDevices', { count: devices.filter((device) => device.connected).length })}
            </div>
            <RemoteDeviceAccessList
              devices={devices}
              onDeviceChange={handleDeviceChange}
              onError={setDeviceError}
            />
            {deviceError && <div role="status" className="project-local-sharing-error">{deviceError}</div>}
          </div>
        <div className="project-local-sharing-actions">
          {shareValue && <Button variant="ghost" onClick={() => void copyText(shareValue)}>{t('common.copy')}</Button>}
          <Button
            variant="primary"
            loading={loading}
            disabled={accessDuration === 'custom' && !customExpiry}
            onClick={() => void createShare()}
          >
            {t('layout.generateShare')}
          </Button>
        </div>
  </div>
}
