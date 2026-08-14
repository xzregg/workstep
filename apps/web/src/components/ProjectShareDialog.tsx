import { useEffect, useState } from 'react'
import { remoteProjectApi, type Project, type RemoteDevice } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import Field from './Field'

interface ProjectShareDialogProps {
  project: Project | null
  onClose: () => void
}

export default function ProjectShareDialog({ project, onClose }: ProjectShareDialogProps) {
  const { t } = useI18n()
  const [access, setAccess] = useState<'internal' | 'external'>('internal')
  const [shareValue, setShareValue] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const projectId = project?.id

  useEffect(() => {
    if (!projectId) return
    let active = true
    setAccess('internal')
    setShareValue('')
    setError('')
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
      const result = await remoteProjectApi.createShare(project.id, access)
      setShareValue(result.share_string)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('layout.remoteShareFailed'))
    } finally {
      setLoading(false)
    }
  }

  const changeAccess = (next: 'internal' | 'external') => {
    setAccess(next)
    setShareValue('')
    setError('')
  }

  const authorizedDevices = devices.filter((device) => !device.revoked)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('layout.remoteShareTitle')} · ${project.name}`}
        style={{ width: 560 }}
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
          {shareValue && (
            <Field label={t('layout.remoteShareString')}>
              <textarea
                readOnly
                value={shareValue}
                rows={6}
                style={{ width: '100%', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--surface)', color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
            </Field>
          )}
          {error && <div role="status" style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 7 }}>
              {t('layout.remoteDevices', { count: authorizedDevices.filter((device) => device.connected).length })}
            </div>
            {authorizedDevices.map((device) => (
              <div key={`${device.project_id}:${device.device_id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ color: device.connected ? 'var(--success)' : 'var(--meta)' }}>{device.connected ? '●' : '○'}</span>
                <span style={{ color: 'var(--fg)' }}>{device.user_name || t('common.unknown')}</span>
                <span>{device.device_name}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          {shareValue && <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(shareValue)}>{t('common.copy')}</Button>}
          <Button variant="primary" loading={loading} onClick={() => void createShare()}>{t('layout.generateShare')}</Button>
        </div>
      </div>
    </div>
  )
}
