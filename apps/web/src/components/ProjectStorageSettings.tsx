import { useEffect, useState } from 'react'
import { projectApi } from '../api/project'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'
import ProjectStorageField from './ProjectStorageField'
import ConfirmDialog from './ConfirmDialog'
import Button from './Button'

export default function ProjectStorageSettings({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const [storage, setStorage] = useState<{ follow_project: boolean; data_path: string } | null>(null)
  const [pending, setPending] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setStorage(null)
    setError('')
    void projectApi.storage(projectId).then(result => { if (!cancelled) setStorage(result) })
      .catch(reason => { if (!cancelled) setError(String(reason.message || reason)) })
    return () => { cancelled = true }
  }, [projectId])
  const save = async () => {
    if (pending === null || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await projectApi.setStorage(projectId, pending)
      setStorage(result)
      if (result.warning) setError(result.warning)
      useProjectStore.setState(state => ({ projects: state.projects.map(project => project.id === projectId ? { ...project, ...result } : project) }))
      setPending(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setSaving(false) }
  }
  return <div>
    {storage ? <ProjectStorageField value={storage.follow_project} path={storage.data_path} disabled={saving} onChange={value => { setError(''); setPending(value) }} />
      : !error && <Button loading disabled>{t('common.loading')}</Button>}
    {error && <p role="alert" className="project-storage-error">{error}</p>}
    <ConfirmDialog open={pending !== null} title={t('projectStorage.confirmTitle')} message={t('projectStorage.confirmHint')}
      loading={saving} confirmDisabled={saving} onCancel={() => { if (!saving) setPending(null) }} onConfirm={() => void save()}>
      {pending !== null && <ProjectStorageField value={pending} disabled onChange={() => {}} />}
      {error && <p role="alert" className="project-storage-error">{error}</p>}
    </ConfirmDialog>
  </div>
}
