import { lazy, Suspense, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { taskWorkflowApi, type TaskWorkflowConfiguration } from '../api/taskWorkflow'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import ResizablePanel from './ResizablePanel'
import Spinner from './Spinner'
import Select from './Select'
import './TaskWorkflowTools.css'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useOverlay } from '../hooks/useOverlay'

const FlowCanvas = lazy(() => import('./FlowCanvas'))

interface Props {
  taskId: string
  projectId: string
  configuration: TaskWorkflowConfiguration
  onChanged: (configuration: TaskWorkflowConfiguration) => void
  readOnly?: boolean
}

/** Owns editing, sync confirmation, dirty-close protection, and error recovery. */
export default function TaskWorkflowTools({ taskId, projectId, configuration, onChanged, readOnly }: Props) {
  const { t } = useI18n()
  const { canEdit } = useGatewayProjectPermissions(projectId)
  const [open, setOpen] = useState(false)
  const [editingConfiguration, setEditingConfiguration] = useState<TaskWorkflowConfiguration | null>(null)
  const [dirty, setDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [confirmSync, setConfirmSync] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [contextMode, setContextMode] = useState('smart')
  const panelRef = useRef<HTMLDivElement>(null)
  const editable = !readOnly && canEdit && configuration.editable
  const title = t(editable ? 'taskWorkflow.edit' : 'taskWorkflow.view')
  const current = editingConfiguration || configuration
  const stale = current.revision !== configuration.revision
  const close = () => {
    if (saving || syncing) return
    if (dirty) setDiscard(true)
    else setOpen(false)
  }
  useOverlay(open, close, panelRef, false)
  const save = async (workflow: any) => {
    setSaving(true)
    setError('')
    try {
      const result = await taskWorkflowApi.save(taskId, projectId, workflow, current.revision, contextMode)
      setEditingConfiguration(result)
      onChanged(result)
      setDirty(false)
    } catch (reason) {
      setError(String(reason))
      throw reason
    } finally { setSaving(false) }
  }
  const sync = async () => {
    setSyncing(true)
    setError('')
    try {
      const result = await taskWorkflowApi.sync(taskId, projectId, current.revision)
      setEditingConfiguration(result)
      onChanged(result)
      setDirty(false)
      setConfirmSync(false)
    } catch (reason) { setError(String(reason)) }
    finally { setSyncing(false) }
  }
  return <>
    <div className="task-workflow-tools">
      <Button variant="ghost" onClick={() => { setEditingConfiguration(configuration); setError(''); setOpen(true) }}>{title}</Button>
      {configuration.has_overrides && <span>{t('taskWorkflow.customized')}</span>}
      {configuration.conflict && <span role="alert">{configuration.conflict}</span>}
    </div>
    {open && <div className="task-workflow-overlay" onClick={close}>
      <ResizablePanel role="dialog" aria-modal="true" aria-label={title}
        ref={panelRef}
        className="task-workflow-panel" minWidth={600} minHeight={400} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <span>{title}</span>
          <Button variant="ghost" disabled={saving || syncing} onClick={close}>{t('common.close')}</Button>
        </div>
        <div className="task-workflow-notice">
          {t('taskWorkflow.rules')}
          {configuration.conflict && <div role="alert">{configuration.conflict}</div>}
          {stale && <div role="alert">{t('taskWorkflow.changed')}</div>}
          {!editable && <div>{t('taskWorkflow.stopFirst')}</div>}
          {error && <div role="alert">{error}</div>}
        </div>
        <div className="task-workflow-canvas">
          <Suspense fallback={<Spinner />}>
            <FlowCanvas initialSteps={current.workflow} onSave={save} onDirtyChange={setDirty}
              taskWorkflowSource={current.source} readOnly={!editable || stale || saving || syncing}
              projectId={projectId} title={title} showTemplatePicker={false}
              toolbarRight={<>
                <Select aria-label={t('taskWorkflow.handoff')} value={contextMode} onChange={(event) => setContextMode(event.target.value)}>
                  <option value="smart">{t('taskWorkflow.smart')}</option>
                  <option value="full">{t('taskWorkflow.full')}</option>
                  <option value="none">{t('taskWorkflow.none')}</option>
                </Select>
                <Button variant="ghost" disabled={!editable || stale || saving || syncing || !configuration.has_overrides}
                  onClick={() => setConfirmSync(true)}>{t('taskWorkflow.sync')}</Button>
              </>} />
          </Suspense>
        </div>
      </ResizablePanel>
    </div>}
    <ConfirmDialog open={discard} title={t('taskWorkflow.discard')} onCancel={() => setDiscard(false)}
      onConfirm={() => { setDiscard(false); setDirty(false); setOpen(false) }} />
    <ConfirmDialog open={confirmSync} title={t('taskWorkflow.sync')} message={t('taskWorkflow.syncWarning')}
      loading={syncing} confirmDisabled={syncing} danger onCancel={() => { if (!syncing) setConfirmSync(false) }} onConfirm={() => void sync()} />
  </>
}
