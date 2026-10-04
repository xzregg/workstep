import { useEffect, useRef, useState } from 'react'
import { fsApi } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import MarkdownEditor from './MarkdownEditor'

interface Props {
  projectId: string
  onClose: () => void
}

/** Owns project memory loading, editing, saving, and unsaved-change protection. */
export default function ProjectMemoryPanel({ projectId, onClose }: Props) {
  const { t } = useI18n()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const savedContent = useRef('')

  useEffect(() => {
    let active = true
    void fsApi.readMemory(projectId).then((result) => {
      if (!active) return
      savedContent.current = result.content
      setContent(result.content)
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : t('taskList.readMemoryFailed'))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId, t])

  const requestClose = () => {
    if (saving) return
    if (content !== savedContent.current) setConfirmClose(true)
    else onClose()
  }

  const save = async () => {
    if (loading || saving) return
    setSaving(true)
    setError('')
    try {
      await fsApi.saveMemory(projectId, content)
      savedContent.current = content
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('taskList.saveMemoryFailed'))
    } finally {
      setSaving(false)
    }
  }

  return <>
    <div className="project-memory-backdrop" onClick={requestClose} />
    <div role="dialog" aria-modal="true" aria-label={t('taskList.editMemory')}
      className="project-memory-panel mobile-auxiliary-panel">
      <div className="panel-header">
        <span className="project-memory-heading">
          {t('taskList.editMemory')}
          <span className="project-memory-path">.workstep/MEMORY.md</span>
        </span>
        <Button variant="icon" onClick={requestClose} aria-label={t('common.close')}>✕</Button>
      </div>
      {error && <div className="project-memory-error" role="alert">{error}</div>}
      <div className="project-memory-body">
        {loading ? <div className="project-memory-loading">{t('common.loading')}</div> :
          <MarkdownEditor value={content} onChange={setContent} projectId={projectId}
            ariaLabel={t('taskList.projectMemory')} />}
      </div>
      <div className="panel-footer project-memory-footer">
        <Button variant="ghost" onClick={requestClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={loading || saving} loading={saving}>
          {t('taskList.saveMemory')}
        </Button>
      </div>
    </div>
    <ConfirmDialog open={confirmClose} title={t('taskList.discardMemoryTitle')}
      message={t('taskList.discardMemoryMessage')}
      confirmText={t('layout.discardChanges')} danger
      onConfirm={onClose} onCancel={() => setConfirmClose(false)} />
  </>
}
