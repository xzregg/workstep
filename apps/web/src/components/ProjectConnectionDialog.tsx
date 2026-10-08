import ProjectStorageField from './ProjectStorageField'
import ResizablePanel from './ResizablePanel'
import { useEffect, useState } from 'react'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import type { Project } from '../api/client'
import Button from './Button'
import DirectoryBrowser from './DirectoryBrowser'
import Field from './Field'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { useManagedMode } from '../hooks/useManagedMode'

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
  const managedMode = useManagedMode()
  const initProject = useProjectStore((state) => state.initProject)
  const addRemoteProject = useProjectStore((state) => state.addRemoteProject)
  const [mode, setMode] = useState<'local' | 'remote'>('local')
  const [remoteShareString, setRemoteShareString] = useState('')
  const [addingRemote, setAddingRemote] = useState(false)
  const [path, setPath] = useState('')
  const [followProject, setFollowProject] = useState(true)
  const [initializing, setInitializing] = useState(false)
  const [error, setError] = useState('')
  const defaultDirectory = useUserSettingsStore((state) => state.defaultProjectDirectory)
  const settingsLoaded = useUserSettingsStore((state) => state.loaded)
  const loadSettings = useUserSettingsStore((state) => state.load)

  useEffect(() => {
    if (open && !isGatewayRemoteBrowser()) void loadSettings()
  }, [open, loadSettings])

  useEffect(() => {
    if (managedMode === true) setMode('local')
  }, [managedMode])

  if (!open) return null

  if (isGatewayRemoteBrowser()) return <div className="modal-overlay" onClick={onClose}>
    <ResizablePanel className="modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header"><span className="modal-title">{t('layout.initTitle')}</span></div>
      <div className="modal-body"><p>{t('gatewayRemote.localOnly')}</p></div>
      <div className="modal-footer"><Button variant="primary" onClick={onClose}>{t('common.close')}</Button></div>
    </ResizablePanel>
  </div>

  const close = () => {
    setMode('local')
    setRemoteShareString('')
    setAddingRemote(false)
    setPath('')
    setFollowProject(true)
    setError('')
    onClose()
  }

  const handleInit = async () => {
    if (!path.trim() || initializing) return
    setError('')
    setInitializing(true)
    try {
      const project = await initProject(path.trim(), undefined, followProject)
      onConnected(project)
      close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setInitializing(false) }
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
      <ResizablePanel
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
            {managedMode !== true && <Button
              variant={mode === 'remote' ? 'primary' : 'ghost'}
              onClick={() => { setMode('remote'); setPath(''); setError('') }}
            >
              {t('layout.remoteProject')}
            </Button>}
          </div>
          {mode === 'local' ? (
            <>
              <div style={{ marginBottom: 8, color: 'var(--fg-2)', fontSize: 'calc(13px * var(--font-scale))' }}>
                {t('browser.selectHint')}
              </div>
              {settingsLoaded && <DirectoryBrowser onSelect={setPath} selectedPath={path} initialPath={defaultDirectory || undefined} />}
              <ProjectStorageField value={followProject} onChange={setFollowProject} disabled={initializing} />
              <p className="project-storage-existing-hint">{t('projectStorage.existingHint')}</p>
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
            <Button variant="primary" loading={initializing} disabled={!path.trim() || initializing} onClick={handleInit}>{t('layout.init')}</Button>
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
      </ResizablePanel>
    </div>
  )
}
