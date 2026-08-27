import { useEffect, useState } from 'react'
import { remoteProjectApi, type Project, type RemoteDevice } from '../api/client'
import { useI18n } from '../i18n'
import { resolveAccessExpiresAt, type AccessDurationPreset } from '../utils/remoteDeviceAccess'
import Button from './Button'
import Field from './Field'
import Input from './Input'
import RemoteDeviceAccessList from './RemoteDeviceAccessList'
import Select from './Select'

interface ProjectShareDialogProps {
  project: Project | null
  onClose: () => void
}

export default function ProjectShareDialog({ project, onClose }: ProjectShareDialogProps) {
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
  const projectId = project?.id

  useEffect(() => {
    if (!projectId) return
    let active = true
    setAccess('internal')
    setAccessDuration('permanent')
    setCustomExpiry('')
    setShareValue('')
    setInviteExpiresAt(null)
    setShareAccessExpiresAt(null)
    setError('')
    setDeviceError('')
    setDevices([])

    const refresh = () => {
      void remoteProjectApi.devices(projectId).then((result) => {
        if (active) setDevices(result.devices)
      }).catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [projectId])

  if (!project) return null

  const createShare = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const accessExpiresAt = resolveAccessExpiresAt(accessDuration, customExpiry)
      const result = await remoteProjectApi.createShare(project.id, access, accessExpiresAt)
      setShareValue(result.share_string)
      setInviteExpiresAt(result.expires_at)
      setShareAccessExpiresAt(result.access_expires_at)
    } catch (reason) {
      setError(
        accessDuration === 'custom' && (!customExpiry || new Date(customExpiry).getTime() <= Date.now())
          ? t('layout.expiryFutureRequired')
          : reason instanceof Error
            ? reason.message
            : t('layout.remoteShareFailed'),
      )
    } finally {
      setLoading(false)
    }
  }

  const changeAccess = (next: 'internal' | 'external') => {
    setAccess(next)
    setShareValue('')
    setInviteExpiresAt(null)
    setError('')
  }

  const formatTime = (value: number) => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value * 1000))

  const handleDeviceChange = (device: RemoteDevice) => {
    setDevices((current) => current.map((item) => (
      item.project_id === device.project_id && item.device_id === device.device_id
        ? device
        : item
    )))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('layout.remoteShareTitle')} · ${project.name}`}
        style={{ width: 680, maxHeight: '88vh' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">{t('layout.remoteShareTitle')} · {project.name}</span>
          <Button variant="icon" aria-label={t('common.close')} onClick={onClose}>✕</Button>
        </div>
        <div className="modal-body">
          <Field label={t('layout.accessType')}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant={access === 'internal' ? 'primary' : 'ghost'} onClick={() => changeAccess('internal')}>
                {t('layout.internalAccess')}
              </Button>
              <Button variant={access === 'external' ? 'primary' : 'ghost'} onClick={() => changeAccess('external')}>
                {t('layout.externalAccess')}
              </Button>
            </div>
          </Field>
          <p style={{ margin: '8px 0 12px', color: 'var(--muted)', fontSize: 11 }}>
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
              style={{ width: '100%' }}
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
                style={{ width: '100%', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--surface)', color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
              <div style={{ display: 'grid', gap: 3, marginTop: 7, color: 'var(--muted)', fontSize: 11 }}>
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
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 7 }}>
              {t('layout.remoteDevices', { count: devices.filter((device) => device.connected).length })}
            </div>
            <RemoteDeviceAccessList
              devices={devices}
              onDeviceChange={handleDeviceChange}
              onError={setDeviceError}
            />
            {deviceError && <div role="status" style={{ color: 'var(--danger)', fontSize: 12 }}>{deviceError}</div>}
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          {shareValue && <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(shareValue)}>{t('common.copy')}</Button>}
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
    </div>
  )
}
