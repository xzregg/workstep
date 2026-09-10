import { useState } from 'react'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import type { Project } from '../api/client'
import Button from './Button'
import DirectoryBrowser from './DirectoryBrowser'
import Field from './Field'

interface ProjectConnectionDialogProps {
  open: boolean
  onClose: () => void
  onConnected: (project: Project) => void
}

export default function ProjectConnectionDialog({
  open,
  onClose,
  onConnected,
}: ProjectConnectionDialogProps) {
  const { t } = useI18n()
  const initProject = useProjectStore((state) => state.initProject)
  const addRemoteProject = useProjectStore((state) => state.addRemoteProject)
  const [mode, setMode] = useState<'local' | 'remote'>('local')
  const [remoteShareString, setRemoteShareString] = useState('')
  const [addingRemote, setAddingRemote] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')

  if (!open) return null

  const close = () => {
    setMode('local')
    setRemoteShareString('')
    setAddingRemote(false)
    setPath('')
    setError('')
    onClose()
  }

  const handleInit = async () => {
    if (!path.trim()) return
    setError('')
    try {
      const project = await initProject(path.trim())
      onConnected(project)
      close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const handleAddRemote = async () => {
    if (!remoteShareString.trim() || addingRemote) return
    setAddingRemote(true)
    setError('')
    try {
      const project = await addRemoteProject(remoteShareString)
      onConnected(project)
      close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('layout.remoteAddFailed'))
    } finally {
      setAddingRemote(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal"
        style={{ width: mode === 'local' ? 600 : 440 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">{t('layout.initTitle')}</span>
          <Button variant="icon" onClick={close}>✕</Button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            <Button
              variant={mode === 'local' ? 'primary' : 'ghost'}
              onClick={() => { setMode('local'); setError('') }}
            >
              {t('layout.localProject')}
            </Button>
            <Button
              variant={mode === 'remote' ? 'primary' : 'ghost'}
              onClick={() => { setMode('remote'); setPath(''); setError('') }}
            >
              {t('layout.remoteProject')}
            </Button>
          </div>
          {mode === 'local' ? (
            <>
              <div style={{ marginBottom: 8, color: 'var(--fg-2)', fontSize: 'calc(13px * var(--font-scale))' }}>
                {t('browser.selectHint')}
              </div>
              <DirectoryBrowser onSelect={setPath} selectedPath={path} />
              {error && (
                <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>
                  {error}
                </div>
              )}
            </>
          ) : (
            <Field label={t('layout.remoteShareString')} htmlFor="remote-share-string" error={error}>
              <textarea
                id="remote-share-string"
                value={remoteShareString}
                onChange={(event) => { setRemoteShareString(event.target.value); setError('') }}
                placeholder="workstep://remote-project/v1/..."
                rows={6}
                autoFocus
                style={{ width: '100%', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 'calc(12px * var(--font-scale))' }}
              />
              <div style={{ marginTop: 7, color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))' }}>
                {t('layout.remoteShareHint')}
              </div>
            </Field>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          {mode === 'local' ? (
            <Button variant="primary" disabled={!path.trim()} onClick={handleInit}>{t('layout.init')}</Button>
          ) : (
            <Button
              variant="primary"
              loading={addingRemote}
              disabled={!remoteShareString.trim()}
              onClick={() => void handleAddRemote()}
            >
              {t('layout.connectRemote')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
