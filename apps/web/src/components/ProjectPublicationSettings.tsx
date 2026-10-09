import { useCallback, useEffect, useState } from 'react'
import { projectApi, type ProjectPublicationStatus } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import './ProjectPublicationSettings.css'

export default function ProjectPublicationSettings({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<ProjectPublicationStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStatus(await projectApi.publication(projectId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('projectSettings.access.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  useEffect(() => { void load() }, [load])

  const changePublication = async (published: boolean) => {
    setBusy(true)
    setError('')
    try {
      const result = await projectApi.setPublication(projectId, published)
      setStatus(current => current ? {
        ...current, project_id: result.project_id, status: result.status,
        grants: result.status === 'published' ? current.grants : [],
      } : current)
      setConfirmUnpublish(false)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('projectSettings.access.changeFailed'))
    } finally {
      setBusy(false)
    }
  }

  return <section className="project-publication-settings">
    {loading && !status && <p role="status">{t('common.loading')}</p>}
    {error && <div role="alert"><p>{error}</p>
      {!status && <Button variant="ghost" onClick={() => void load()}>{t('projectSettings.access.retry')}</Button>}
    </div>}
    {status && <>
      <p>{status.status === 'published'
        ? t('projectSettings.access.published') : t('projectSettings.access.unpublished')}</p>
      {status.can_publish && <Button variant={status.status === 'published' ? 'danger' : 'primary'}
        loading={busy} disabled={loading}
        onClick={() => status.status === 'published'
          ? setConfirmUnpublish(true) : void changePublication(true)}>{
          status.status === 'published'
            ? t('projectSettings.access.unpublish') : t('projectSettings.access.publish')
        }</Button>}
      {status.status === 'published' && <>
        <h3>{t('projectSettings.access.grants')}</h3>
        {status.grants.length === 0 ? <p>{t('projectSettings.access.empty')}</p> :
          <ul>{status.grants.map(grant => <li key={`${grant.subject_type}:${grant.subject_id}`}>{
            t(`projectSettings.access.${grant.subject_type}`)} · {grant.subject_name} · {
            t(`projectSettings.access.${grant.access_level}`)}</li>)}</ul>}
        {status.can_manage && <a href={`${status.gateway_url}/admin/projects`}>
          {t('projectSettings.access.manage')}
        </a>}
        {status.can_invite && status.project_id && <div className="project-publication-invite">
          <a href={`${status.gateway_url.replace(/\/$/, '')}/project-invitations?project_id=${encodeURIComponent(status.project_id)}`}>
            {t('projectSettings.access.invite')}
          </a>
          <p>{t('projectSettings.access.inviteHint')}</p>
        </div>}
      </>}
    </>}
    <div onClick={event => event.stopPropagation()}>
      <ConfirmDialog open={confirmUnpublish}
        title={t('projectSettings.access.unpublish')}
        message={t('projectSettings.access.unpublishHint')}
        confirmText={t('projectSettings.access.confirmUnpublish')}
        danger loading={busy}
        onCancel={() => setConfirmUnpublish(false)}
        onConfirm={() => void changePublication(false)} />
    </div>
  </section>
}
