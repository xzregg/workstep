import { lazy, Suspense, useEffect, useImperativeHandle, useState, type Ref } from 'react'
import type { Project } from '../api/project'
import { workflowDebugApi, type DebugHistory, type DebugWorkflow } from '../api/workflowDebug'
import { useWsSubscriptionStore } from '../hooks/useWebSocket'
import { localizeErrorDisplay, useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Field from './Field'
import FlowCanvas, { type FlowCanvasHandle } from './FlowCanvas'
import Input from './Input'
import MarkdownEditor from './MarkdownEditor'
import RadioCardGroup from './RadioCardGroup'
import Spinner from './Spinner'
import './WorkflowDebugControls.css'

const TaskDetail = lazy(() => import('../pages/TaskDetail'))

export function debugUpstream(workflow: DebugWorkflow, key: string) {
  const selected = workflow.nodes.find(node => node.type === key)
  const sources = new Map(workflow.nodes.map(node => [node.id, node]))
  const outputs = new Map<string, { key: string; step_key: string; port: number; label: string; name: string; textUnsupported: boolean }>()
  for (const connection of workflow.connections) {
    if (connection.to !== selected?.id || connection.kind === 'dashed') continue
    const source = sources.get(connection.from)
    const port = connection.fromPort ?? 0
    const output = source?.outputs?.[port]
    if (!source || !output) continue
    const id = `${source.type}:${port}`
    outputs.set(id, { key: id, step_key: source.type, port, label: source.title || source.type,
      name: output.name || String(port + 1), textUnsupported: /^(directory|jpg|jpeg|png|pdf|docx|xlsx)$/i.test(output.type || '') || /\.(jpe?g|png|pdf|docx|xlsx)$/i.test(output.name || '') })
  }
  return [...outputs.values()]
}

export function StartDebug({ workflow, busy, restarting = false, initialStep, onStart, onCancel }: {
  workflow: DebugWorkflow
  busy: boolean
  restarting?: boolean
  initialStep?: string
  onCancel?: () => void
  onStart: (values: Parameters<typeof workflowDebugApi.start>[2]) => void
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [step, setStep] = useState(initialStep ?? workflow.nodes[0]?.type ?? '')
  const [samples, setSamples] = useState<Record<string, string>>({})
  const outputs = debugUpstream(workflow, step)
  const unsupportedOutput = outputs.some(output => output.textUnsupported)
  const valid = Boolean(step && (restarting || title.trim() && !unsupportedOutput && outputs.every(output => samples[output.key]?.trim())))
  return <form className="workflow-debug-fields" id="workflow-debug-form" onSubmit={event => {
    event.preventDefault()
    if (valid && !busy) onStart({ workflow, title, description, step_key: step,
      samples: outputs.filter(output => !restarting || samples[output.key]?.trim()).map(output => ({ step_key: output.step_key, port: output.port, content: samples[output.key] })) })
  }}>
    {!restarting && <Field label={t('canvas.debugTitle')} htmlFor="debug-title" required>
      <Input id="debug-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} />
    </Field>}
    <Field label={t(restarting ? 'canvas.debugInstruction' : 'canvas.debugDescription')} htmlFor="debug-description">
      <MarkdownEditor id="debug-description" value={description} onChange={setDescription}
        minHeight={64} disabled={busy} allowAttachments={false} placeholder="" />
    </Field>
    <RadioCardGroup variant="compact" label={t('canvas.debugStartStep')} value={step} required disabled={busy}
      options={workflow.nodes.map(node => ({ value: node.type, label: node.title || node.type }))}
      onChange={setStep} />
    {outputs.length > 0 && <section className="workflow-debug-samples">
      <h3>{t('canvas.debugInputs')}</h3>
      {outputs.map(output => <Field key={output.key} label={`${output.label} / ${output.name}`}
        htmlFor={`debug-sample-${output.key}`} required={!restarting}
        help={restarting && !output.textUnsupported ? t('canvas.debugKeepInput') : undefined}
        error={output.textUnsupported ? t('canvas.debugDirectoryUnsupported') : undefined}>
        <MarkdownEditor id={`debug-sample-${output.key}`} value={samples[output.key] || ''}
          disabled={busy || output.textUnsupported} minHeight={96} maxLength={256_000} allowAttachments={false}
          placeholder=""
          onChange={value => setSamples(current => ({ ...current, [output.key]: value }))} />
      </Field>)}
    </section>}
    <div className="workflow-debug-actions">
      {onCancel && <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>}
      <Button type="submit" variant="primary" loading={busy} disabled={!valid}>{t(restarting ? 'canvas.debugRestart' : 'canvas.debugLaunch')}</Button>
    </div>
  </form>
}

export interface WorkflowDebugHandle {
  open: (nodeId: string) => void
}

export default function WorkflowDebugControls({ project, sourceId, readDraft, ref }: {
  ref?: Ref<WorkflowDebugHandle>
  project: Project
  sourceId: string
  readDraft: () => ReturnType<FlowCanvasHandle['getDraft']> | undefined
}) {
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState<{ workflow: DebugWorkflow; initialStep?: string } | null>(null)
  const [history, setHistory] = useState<DebugHistory | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [activeTask, setActiveTask] = useState('')
  const [restartWorkflow, setRestartWorkflow] = useState<DebugWorkflow | null>(null)
  const [editWorkflow, setEditWorkflow] = useState<DebugWorkflow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [detailRevision, setDetailRevision] = useState(0)
  const [editDirty, setEditDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!activeTask) return
    useWsSubscriptionStore.setState(state => ({ taskIds: [...new Set([...state.taskIds, activeTask])] }))
    return () => useWsSubscriptionStore.setState(state => ({ taskIds: state.taskIds.filter(id => id !== activeTask) }))
  }, [activeTask])

  const perform = async (operation: () => Promise<void>) => {
    if (busy) return
    setError('')
    setBusy(true)
    try { await operation() }
    catch (reason) { setError(localizeErrorDisplay(reason instanceof Error ? reason.message : String(reason))) }
    finally { setBusy(false) }
  }
  const open = (nodeId?: string) => {
    if (busy) return
    const current = readDraft()
    if (!current?.workflow?.nodes?.length || current.error) {
      setError(current?.error || t('canvas.debugRequiresSteps'))
      return
    }
    const workflow: DebugWorkflow = current.workflow
    // Resolve the node against the draft so an unsaved step-key rename is included.
    const selected = nodeId === undefined ? undefined : workflow.nodes.find(node => String(node.id) === nodeId)
    if (nodeId !== undefined && !selected) return
    setError('')
    setDraft({ workflow, initialStep: selected?.type })
  }
  useImperativeHandle(ref, () => ({ open }))

  return <>
    <Button variant="ghost" disabled={busy} onClick={() => open()}>{t('canvas.debug')}</Button>
    <Button variant="ghost" disabled={busy} onClick={() => void perform(async () => {
      setHistoryOpen(true)
      setHistory(await workflowDebugApi.history(project.id, sourceId))
    })}>{t('canvas.debugHistory')}</Button>
    {draft && <ConfirmDialog open width={620} title={t('canvas.debug')} hideFooter loading={busy} onConfirm={() => {}} onCancel={() => { if (!busy) setDraft(null) }}>
      <StartDebug workflow={draft.workflow} initialStep={draft.initialStep} busy={busy} onCancel={() => setDraft(null)} onStart={values => void perform(async () => {
        const result = await workflowDebugApi.start(project.id, sourceId, values)
        setDraft(null)
        setActiveTask(result.id)
        if (result.start_error) setError(localizeErrorDisplay(result.start_error))
      })} />
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
    {historyOpen && <ConfirmDialog open width={620} title={t('canvas.debugHistory')} noConfirm
      cancelText={t('common.close')} onConfirm={() => {}} onCancel={() => { if (!busy) setHistoryOpen(false) }}>
      {!history && busy && <Spinner />}
      {history?.tasks.length === 0 && <p>{t('canvas.debugEmptyHistory')}</p>}
      {history?.tasks.map(task => <div className="workflow-debug-record" key={task.id}>
        <Button variant="ghost" onClick={() => { setHistoryOpen(false); setActiveTask(task.id) }}>{task.title}</Button>
        <time dateTime={task.created_at}>{new Date(task.created_at).toLocaleString(locale)}</time>
        <Button variant="ghost" disabled={busy} onClick={() => setDeleteTarget(task.id)}>{t('common.delete')}</Button>
      </div>)}
      {!!history?.tasks.length && <div className="workflow-debug-actions">
        <Button variant="danger" disabled={busy} onClick={() => setDeleteTarget('')}>{t('canvas.debugClear')}</Button>
      </div>}
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
    {deleteTarget !== null && <ConfirmDialog open danger zIndex={2200}
      title={deleteTarget ? t('taskList.deleteTask') : t('canvas.debugClear')}
      message={t('canvas.debugDeleteMessage')} loading={busy}
      onCancel={() => { if (!busy) setDeleteTarget(null) }}
      onConfirm={() => void perform(async () => {
        await workflowDebugApi.delete(project.id, sourceId, deleteTarget || undefined)
        setDeleteTarget(null)
        setHistory(await workflowDebugApi.history(project.id, sourceId))
      })}>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
    {activeTask && <Suspense fallback={<Spinner />}>
      <TaskDetail key={detailRevision} project={project} taskId={activeTask} onClose={() => void perform(async () => {
        await workflowDebugApi.stop(project.id, sourceId, activeTask)
        setActiveTask('')
      })} debugWorkflowTools={<div className="workflow-debug-tools">
        <Button variant="danger" size="sm" loading={busy} onClick={() => void perform(async () => {
          await workflowDebugApi.stop(project.id, sourceId, activeTask)
          const result = await workflowDebugApi.history(project.id, sourceId)
          setEditDirty(false)
          setEditWorkflow(result.workflow)
        })}>{t('canvas.debugStopAndEdit')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform(async () => {
          await workflowDebugApi.stop(project.id, sourceId, activeTask)
          const current = await workflowDebugApi.history(project.id, sourceId)
          setRestartWorkflow(current.workflow)
        })}>{t('canvas.debugRestart')}</Button>
        {error && <p role="alert">{error}</p>}
      </div>} />
    </Suspense>}
    {restartWorkflow && <ConfirmDialog open hideFooter width={620} zIndex={2200}
      title={t('canvas.debugRestart')} onConfirm={() => {}} onCancel={() => { if (!busy) setRestartWorkflow(null) }}>
      <StartDebug workflow={restartWorkflow} busy={busy} restarting onCancel={() => setRestartWorkflow(null)} onStart={values => void perform(async () => {
        await workflowDebugApi.restart(project.id, sourceId, activeTask, {
          step_key: values.step_key, instruction: values.description, samples: values.samples,
        })
        setRestartWorkflow(null)
        setDetailRevision(value => value + 1)
      })} />
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
    {editWorkflow && <ConfirmDialog open noConfirm width={1040} zIndex={2200}
      title={t('canvas.debugEdit')} cancelText={t('common.close')}
      onConfirm={() => {}} onCancel={() => { if (editDirty) setConfirmDiscard(true); else setEditWorkflow(null) }}>
      <div className="workflow-debug-editor">
        <FlowCanvas initialSteps={editWorkflow} projectId={project.id} onDirtyChange={setEditDirty}
          showTemplatePicker={false} onSave={async workflow => {
            await workflowDebugApi.save(project.id, sourceId, workflow)
            setEditDirty(false)
            setEditWorkflow(null)
            setDetailRevision(value => value + 1)
          }} />
      </div>
    </ConfirmDialog>}
    {confirmDiscard && <ConfirmDialog open zIndex={2300} title={t('canvas.unsavedTitle')}
      message={t('canvas.unsavedLeaveMessage')} onCancel={() => setConfirmDiscard(false)}
      onConfirm={() => { setConfirmDiscard(false); setEditWorkflow(null) }} />}
    {error && !draft && !historyOpen && !activeTask && <ConfirmDialog open noConfirm title={t('canvas.debug')}
      cancelText={t('common.close')} onConfirm={() => {}} onCancel={() => setError('')}><p role="alert">{error}</p></ConfirmDialog>}
  </>
}
