import { useEffect, useState } from 'react'
import { fetchEngineModels, getCachedEngineModels, projectApi, workflowApi, type EngineInfo, type EngineModel, type Project, type WorkflowSummary } from '../api/client'
import { OUTPUT_TYPES, DEFAULT_OUTPUT_TYPE } from '../config/outputTypes'
import { engineLabel } from '../engineMeta'
import { initialStepConfig } from '../utils/stepConfig'
import { useI18n } from '../i18n'
import { STEP_TYPE_PATTERN, randomStepColor, normalizeMaxReturnRounds, emptyReview, syncOutputs, DEFAULT_MAX_RETURN_ROUNDS, MAX_CONFIGURED_RETURN_ROUNDS, type InputField, type ReviewConfig, type StepNodeData } from './flowCanvasData'
import Button from './Button'
import Input from './Input'
import Combobox from './Combobox'
import Select from './Select'
import MarkdownEditor from './MarkdownEditor'
import EngineSelect from './EngineSelect'
import StepConfigFields from './StepConfigFields'
import StepPromptVariablesHint from './StepPromptVariablesHint'
import WorkflowQuickButtonsSection from './WorkflowQuickButtonsSection'

/* ══════════════════════════════════════════
   Section title style
   ══════════════════════════════════════════ */
const sectionTitle: React.CSSProperties = {
  fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
}

/* ══════════════════════════════════════════
   Input editor with sub-outputs
   ══════════════════════════════════════════ */
function InputEditor({ inputs, onChange }: { inputs: InputField[]; onChange: (v: InputField[]) => void }) {
  const { t } = useI18n()
  const updateInput = (i: number, field: 'name' | 'type', val: string) => {
    const next = [...inputs]; next[i] = { ...next[i], [field]: val }; onChange(next)
  }
  const addInput = () => onChange([...inputs, { name: '', type: DEFAULT_OUTPUT_TYPE, outputs: [] }])
  const removeInput = (i: number) => onChange(inputs.filter((_, idx) => idx !== i))

  const addSubOutput = (i: number) => {
    const next = [...inputs]
    next[i] = { ...next[i], outputs: [...next[i].outputs, { name: '', type: DEFAULT_OUTPUT_TYPE }] }
    onChange(next)
  }
  const updateSubOutput = (i: number, j: number, field: 'name' | 'type', val: string) => {
    const next = [...inputs]
    const subs = [...next[i].outputs]; subs[j] = { ...subs[j], [field]: val }
    next[i] = { ...next[i], outputs: subs }; onChange(next)
  }
  const removeSubOutput = (i: number, j: number) => {
    const next = [...inputs]
    next[i] = { ...next[i], outputs: next[i].outputs.filter((_, idx) => idx !== j) }
    onChange(next)
  }

  return (
    <div>
      <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--accent)' }}>●</span> {t('flow.inputArtifacts')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {inputs.map((inp, i) => (
          <div key={i} style={{ background: 'var(--surface)', borderRadius: 6, padding: 8, border: '1px solid var(--border-soft)' }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <Input value={inp.name} onChange={(e) => updateInput(i, 'name', e.target.value)} placeholder={t('flow.name')} style={{ flex: 1, height: 28, fontSize: 'calc(13px * var(--font-scale))' }} />
              <Combobox value={inp.type} options={OUTPUT_TYPES} onChange={(v) => updateInput(i, 'type', v)} placeholder={t('flow.type')} style={{ width: 80, height: 28, fontSize: 'calc(13px * var(--font-scale))', border: '1px solid var(--border)', borderRadius: 4 }} />
              <Button variant="icon" onClick={() => removeInput(i)} style={{ width: 22, height: 22, color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))' }}>×</Button>
            </div>
            {/* Sub-outputs */}
            {inp.outputs.map((sub, j) => (
              <div key={j} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4, marginLeft: 14 }}>
                <span style={{ color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))' }}>↳</span>
                <Input value={sub.name} onChange={(e) => updateSubOutput(i, j, 'name', e.target.value)} placeholder={t('flow.outputName')} style={{ flex: 1, height: 24, fontSize: 'calc(11px * var(--font-scale))' }} />
                <Combobox value={sub.type} options={OUTPUT_TYPES} onChange={(v) => updateSubOutput(i, j, 'type', v)} placeholder={t('flow.type')} style={{ width: 80, height: 24, fontSize: 'calc(11px * var(--font-scale))', border: '1px solid var(--border)', borderRadius: 3 }} />
                <Button variant="icon" onClick={() => removeSubOutput(i, j)} style={{ width: 20, height: 20, color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))' }}>×</Button>
              </div>
            ))}
            <button onClick={() => addSubOutput(i)} style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--success)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4, marginLeft: 14, padding: '2px 0' }}>
              {t('flow.addSubOutput')}
            </button>
          </div>
        ))}
        <button onClick={addInput} style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
          {t('flow.addInput')}
        </button>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════
   Node Config Panel — edits are local until saved
   ══════════════════════════════════════════ */
export default function NodeConfigPanel({ node, unavailableKeys, engines, enginesLoading, enginesError, defaultExecutionEngine, onValidationChange, onDraftChange, onSave, onRequestDelete, onClose, onDirtyChange, projectId, workflowId }: {
  node: StepNodeData
  unavailableKeys: string[]
  engines: EngineInfo[]
  enginesLoading: boolean
  enginesError: string
  defaultExecutionEngine: string
  onValidationChange: (error: string) => void
  onDraftChange: (data: StepNodeData) => void
  onSave: (data: StepNodeData) => void
  onRequestDelete: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  projectId?: string
  workflowId?: string
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<StepNodeData>({ ...node, inputs: node.inputs.map((i) => ({ ...i, outputs: [...i.outputs] })) })
  const [stepModels, setStepModels] = useState<EngineModel[]>([])
  const [reviewModels, setReviewModels] = useState<EngineModel[]>([])
  const [stepModelsLoading, setStepModelsLoading] = useState(false)
  const [reviewModelsLoading, setReviewModelsLoading] = useState(false)
  const [dispatchProjects, setDispatchProjects] = useState<Project[]>([])
  const [dispatchWorkflows, setDispatchWorkflows] = useState<WorkflowSummary[]>([])
  const [dispatchSteps, setDispatchSteps] = useState<Array<{ key: string; label: string }>>([])
  const dispatchConfig = draft.dispatch || {
    targetProjectId: '', targetWorkflowId: '', targetStartStepKey: '', startMode: 'inherit' as const,
  }

  // Sync draft when node changes (e.g. clicking different node)

  // Detect dirty state
  useEffect(() => {
    const changed = JSON.stringify(draft) !== JSON.stringify(node)
    onDirtyChange(changed)
    onDraftChange(draft)
  }, [draft, node, onDirtyChange, onDraftChange])
  useEffect(() => {
    setDraft({ ...node, inputs: node.inputs.map((i) => ({ ...i, outputs: [...i.outputs] })) })
  }, [node])

  const updateDraft = (field: string, value: any) => {
    let updated = { ...draft, [field]: value }
    if (field === 'inputs') updated = { ...updated, outputs: syncOutputs(value as InputField[]) }
    setDraft(updated)
  }

  const normalizedKey = (draft.key ?? '').trim()
  const keyError = !normalizedKey
    ? t('flow.keyRequired')
    : !STEP_TYPE_PATTERN.test(normalizedKey)
      ? t('flow.keyPattern')
      : unavailableKeys.includes(normalizedKey)
        ? t('flow.keyDuplicate', { key: normalizedKey })
        : ''

  useEffect(() => {
    onValidationChange(keyError)
  }, [keyError, onValidationChange])

  const selectableEngines = engines.filter(
    (engine) => engine.installed && engine.configured
  )
  const effectiveStepEngine = draft.engine || defaultExecutionEngine
  const currentEngineSelectable = !draft.engine || selectableEngines.some(
    (engine) => engine.id === effectiveStepEngine
  )
  const review: ReviewConfig = draft.review || emptyReview()
  const updateReview = (field: keyof ReviewConfig, value: string | number | boolean | Record<string, string>) => {
    updateDraft('review', { ...review, [field]: value })
  }
  const reviewEngine = review.engine || effectiveStepEngine

  const engineConfigById = (engineId: string) =>
    engines.find((engine) => engine.id === engineId)?.config ?? null
  const stepFields = engineConfigById(draft.engine)?.step_fields ?? []
  const reviewFields = engineConfigById(reviewEngine)?.step_fields ?? []
  const updateStepConfig = (key: string, value: string) => {
    const next = { ...(draft.config || {}) }
    if (value === '') delete next[key]
    else next[key] = value
    if (key === 'provider_id') {
      setDraft({ ...draft, config: next, model: '' })
    } else {
      updateDraft('config', next)
    }
  }
  const updateReviewConfig = (key: string, value: string) => {
    const next = { ...(review.config || {}) }
    if (value === '') delete next[key]
    else next[key] = value
    if (key === 'provider_id') {
      updateDraft('review', { ...review, config: next, model: '' })
    } else {
      updateReview('config', next)
    }
  }

  useEffect(() => {
    if (draft.kind !== 'task_dispatch') return
    projectApi.list().then(({ projects }) => setDispatchProjects(projects)).catch(() => setDispatchProjects([]))
  }, [draft.kind])

  useEffect(() => {
    if (draft.kind !== 'task_dispatch' || !dispatchConfig.targetProjectId) {
      setDispatchWorkflows([])
      return
    }
    workflowApi.list(dispatchConfig.targetProjectId)
      .then(({ workflows }) => setDispatchWorkflows(workflows.filter((workflow) => !workflow.deleted)))
      .catch(() => setDispatchWorkflows([]))
  }, [draft.kind, dispatchConfig.targetProjectId])

  useEffect(() => {
    if (draft.kind !== 'task_dispatch' || !dispatchConfig.targetProjectId || !dispatchConfig.targetWorkflowId) {
      setDispatchSteps([])
      return
    }
    workflowApi.get(dispatchConfig.targetWorkflowId, dispatchConfig.targetProjectId)
      .then((workflow) => {
        const raw = workflow.steps?.nodes || workflow.steps?.steps || []
        setDispatchSteps(raw.map((item: any) => ({
          key: item.key || item.type || item.id,
          label: item.label || item.title || item.type || item.id,
        })).filter((item: any) => item.key))
      })
      .catch(() => setDispatchSteps([]))
  }, [draft.kind, dispatchConfig.targetProjectId, dispatchConfig.targetWorkflowId])

  const updateDispatch = (field: string, value: string) => {
    updateDraft('dispatch', { ...dispatchConfig, [field]: value })
  }

  useEffect(() => {
    if (!draft.engine) {
      setStepModels([])
      return
    }
    const providerId = draft.config?.provider_id || ''
    const cached = getCachedEngineModels(draft.engine, providerId)
    if (cached) {
      setStepModels(cached.models || [])
      setStepModelsLoading(false)
      return
    }
    let active = true
    setStepModelsLoading(true)
    fetchEngineModels(draft.engine, false, providerId)
      .then((result) => {
        if (active) setStepModels(result.models || [])
      })
      .catch(() => {
        if (active) setStepModels([])
      })
      .finally(() => {
        if (active) setStepModelsLoading(false)
      })
    return () => { active = false }
  }, [draft.engine, draft.config?.provider_id])

  useEffect(() => {
    if (!reviewEngine) {
      setReviewModels([])
      return
    }
    const providerId = review.config?.provider_id || ''
    const cached = getCachedEngineModels(reviewEngine, providerId)
    if (cached) {
      setReviewModels(cached.models || [])
      setReviewModelsLoading(false)
      return
    }
    let active = true
    setReviewModelsLoading(true)
    fetchEngineModels(reviewEngine, false, providerId)
      .then((result) => {
        if (active) setReviewModels(result.models || [])
      })
      .catch(() => {
        if (active) setReviewModels([])
      })
      .finally(() => {
        if (active) setReviewModelsLoading(false)
      })
    return () => { active = false }
  }, [reviewEngine, review.config?.provider_id])

  if (draft.kind === 'task_dispatch') {
    return (
      <div className="flow-node-config-panel" style={{ width: '50vw', minWidth: 420, maxWidth: '50vw', flexShrink: 0, background: 'var(--bg)', borderLeft: '1px solid var(--border-soft)', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 28, height: 28, borderRadius: 6, background: `${draft.color}20`, color: draft.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{draft.label.charAt(0)}</div><span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{draft.label}</span></div>
          <div style={{ display: 'flex', gap: 6 }}><Button variant="primary" style={{ fontSize: 'calc(13px * var(--font-scale))', padding: '4px 12px' }} disabled={Boolean(keyError) || !dispatchConfig.targetProjectId || !dispatchConfig.targetWorkflowId || !dispatchConfig.targetStartStepKey} onClick={() => onSave({ ...draft, key: normalizedKey })}>{t('flow.stash')}</Button><Button variant="icon" onClick={onClose}>✕</Button></div>
        </div>
        <div><div style={sectionTitle}>{t('flow.basicInfo')}</div><div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.name')}<Input value={draft.label} onChange={(e) => updateDraft('label', e.target.value)} style={{ marginTop: 4 }} /></label><label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.stepKey')}<Input value={draft.key} onChange={(e) => updateDraft('key', e.target.value)} style={{ marginTop: 4 }} /></label></div></div>
        <div><div style={sectionTitle}>{t('flow.dispatchTarget')}</div><div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.targetProject')}<Select value={dispatchConfig.targetProjectId} onChange={(e) => { updateDraft('dispatch', { ...dispatchConfig, targetProjectId: e.target.value, targetWorkflowId: '', targetStartStepKey: '' }) }} style={{ marginTop: 4 }}><option value="">{t('flow.selectTarget')}</option>{dispatchProjects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.type === 'remote' ? ' · 远程' : ''}</option>)}</Select></label>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.targetWorkflow')}<Select value={dispatchConfig.targetWorkflowId} onChange={(e) => updateDraft('dispatch', { ...dispatchConfig, targetWorkflowId: e.target.value, targetStartStepKey: '' })} style={{ marginTop: 4 }} disabled={!dispatchConfig.targetProjectId}><option value="">{t('flow.selectTarget')}</option>{dispatchWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</Select></label>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.targetStartStep')}<Select value={dispatchConfig.targetStartStepKey} onChange={(e) => updateDispatch('targetStartStepKey', e.target.value)} style={{ marginTop: 4 }} disabled={!dispatchConfig.targetWorkflowId}><option value="">{t('flow.selectTarget')}</option>{dispatchSteps.map((step) => <option key={step.key} value={step.key}>{step.label}（{step.key}）</option>)}</Select></label>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.startMode')}<Select value={dispatchConfig.startMode || 'inherit'} onChange={(e) => updateDispatch('startMode', e.target.value)} style={{ marginTop: 4 }}><option value="inherit">{t('flow.inheritAutoStart')}</option><option value="immediate">{t('flow.immediateStart')}</option></Select></label>
        </div></div>
        <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)', lineHeight: 1.5 }}>{t('flow.dispatchTerminalHint')}</div>
      </div>
    )
  }

  return (
    <div className="flow-node-config-panel" style={{ width: '50vw', minWidth: 420, maxWidth: '50vw', flexShrink: 0, background: 'var(--bg)', borderLeft: '1px solid var(--border-soft)', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: `${draft.color}20`, color: draft.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
            {draft.label.charAt(0)}
          </div>
          <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{draft.label}</span>
          <button onClick={onRequestDelete}
            style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', padding: '2px 8px', borderRadius: 'var(--radius-sm)', marginLeft: 8 }}>
            {t('common.delete')}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Button
            variant="primary"
            style={{ fontSize: 'calc(13px * var(--font-scale))', padding: '4px 12px' }}
            disabled={Boolean(keyError)}
            onClick={() => onSave({ ...draft, key: normalizedKey })}
          >
            {t('flow.stash')}
          </Button>
          <Button variant="icon" onClick={onClose}>✕</Button>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>{t('flow.basicInfo')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.name')}</label>
              <Input value={draft.label} onChange={(e) => updateDraft('label', e.target.value)} />
            </div>
            <div style={{ width: 116 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.color')}</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  type="color"
                  aria-label={t('flow.stepColor')}
                  value={draft.color}
                  onChange={(e) => updateDraft('color', e.target.value)}
                  style={{ height: 32, width: 42, cursor: 'pointer', padding: 2 }}
                />
                <Button
                  variant="ghost"
                  aria-label={t('flow.randomColor')}
                  title={t('flow.randomColor')}
                  onClick={() => updateDraft('color', randomStepColor(draft.color))}
                  style={{ height: 32, flex: 1, padding: '0 7px', fontSize: 'calc(11px * var(--font-scale))' }}
                >
                  {t('flow.random')}
                </Button>
              </div>
            </div>
          </div>
          <div>
            <label htmlFor="step-type" style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>
              {t('flow.stepKey')}<span style={{ color: 'var(--danger)' }}> *</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Input
                id="step-type"
                value={draft.key}
                onChange={(e) => updateDraft('key', e.target.value)}
                required
                aria-invalid={Boolean(keyError)}
                aria-describedby={keyError ? 'step-type-error' : 'step-type-help'}
                style={{ flex: 1, ...(keyError ? { borderColor: 'var(--danger)' } : {}) }}
                placeholder="frontend"
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input
                type="checkbox"
                checked={Boolean(draft.autoStart)}
                onChange={(e) => {
                  const updated = { ...draft, autoStart: e.target.checked }
                  setDraft(updated)
                  onSave({ ...updated, key: normalizedKey })
                }}
                style={{ width: 16, height: 16 }}
                />
                {t('flow.autoStart')}
              </label>
            </div>
            <div
              id={keyError ? 'step-type-error' : 'step-type-help'}
              style={{ marginTop: 4, fontSize: 'calc(11px * var(--font-scale))', color: keyError ? 'var(--danger)' : 'var(--fg-3)', lineHeight: 1.4 }}
            >
              {keyError || t('flow.keyHelp')}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.prompt')}</label>
            <MarkdownEditor
              value={draft.prompt}
              onChange={(v) => updateDraft('prompt', v)}
              projectId={projectId}
              minHeight={120}
              placeholder={t('flow.promptPlaceholder')}
              ariaLabel={t('flow.stepPromptAria')}
            />
            <StepPromptVariablesHint />
          </div>
          <InputEditor
            inputs={draft.inputs}
            onChange={(inputs) => updateDraft('inputs', inputs)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.engine')}</label>
              <EngineSelect
                engines={engines}
                value={draft.engine}
                onChange={(engineId) => {
                  setDraft((current) => ({
                    ...current,
                    engine: engineId,
                    model: '',
                    config: engineId
                      ? initialStepConfig(engineConfigById(engineId))
                      : {},
                  }))
                }}
                disabled={enginesLoading}
                defaultOption={{
                  value: '',
                  label: t('flow.defaultExecutionEngineOption', {
                    engine: engineLabel(defaultExecutionEngine, t),
                  }),
                }}
                ariaLabel={t('flow.stepEngineAria')}
                style={{ height: 32 }}
              />
              <div style={{
                marginTop: 4, fontSize: 'calc(11px * var(--font-scale))', lineHeight: 1.4,
                color: enginesError
                  ? 'var(--danger)'
                  : currentEngineSelectable
                    ? 'var(--meta)'
                    : 'var(--warn)',
              }}>
                {enginesLoading
                  ? t('flow.scanningEngines')
                  : enginesError
                    ? t('flow.engineScanFailed', { error: enginesError })
                    : currentEngineSelectable
                      ? t('flow.enginesConfigured', { count: selectableEngines.length })
                      : t('flow.engineUnavailable')}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.modelOptional')}</label>
              <Select
                value={draft.model}
                disabled={!draft.engine || stepModelsLoading}
                onChange={(e) => updateDraft('model', e.target.value)}
                style={{ height: 32 }}
              >
                <option value="">
                  {stepModelsLoading ? t('flow.modelsLoading') : t('flow.engineDefaultModel')}
                </option>
                {draft.model && !stepModels.some((model) => model.id === draft.model) && (
                  <option value={draft.model}>{draft.model}{t('flow.currentConfigSuffix')}</option>
                )}
                {stepModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label || model.id}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {stepFields.length > 0 && (
            <div>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>
                {t('flow.stepConfig')}
              </label>
              <StepConfigFields
                engineId={draft.engine}
                fields={stepFields}
                values={draft.config || {}}
                onChange={(key, value) => updateStepConfig(key, value)}
              />
            </div>
          )}
          <div>
            <div style={sectionTitle}>{t('flow.returnRouting')}</div>
            <label
              htmlFor={`step-max-return-rounds-${draft.nodeId}`}
              style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}
            >
              {t('flow.maxReturnRounds')}
            </label>
            <Input
              id={`step-max-return-rounds-${draft.nodeId}`}
              aria-label={t('flow.maxReturnRounds')}
              type="number"
              min={1}
              max={MAX_CONFIGURED_RETURN_ROUNDS}
              step={1}
              value={draft.maxReturnRounds}
              onChange={(event) => updateDraft(
                'maxReturnRounds',
                normalizeMaxReturnRounds(event.target.value),
              )}
              style={{ width: 72, height: 32, fontVariantNumeric: 'tabular-nums' }}
            />
            <div style={{ marginTop: 5, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', lineHeight: 1.5, maxWidth: '68ch' }}>
              {t('flow.maxReturnRoundsHint', {
                default: DEFAULT_MAX_RETURN_ROUNDS,
                max: MAX_CONFIGURED_RETURN_ROUNDS,
              })}
            </div>
          </div>
          <div>
            <div style={sectionTitle}>{t('flow.stepReview')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {([
                    ['skip', t('flow.reviewSkip')],
                    ['auto', t('flow.autoReview')],
                    ['manual', t('flow.manualReview')],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => updateReview('mode', value)}
                      style={{
                        padding: '3px 10px', fontSize: 'calc(12px * var(--font-scale))', borderRadius: 999,
                        border: review.mode === value ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: review.mode === value ? 'color-mix(in oklab, var(--accent), transparent 88%)' : 'transparent',
                        color: review.mode === value ? 'var(--accent)' : 'var(--fg-2)',
                        cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {review.mode === 'auto' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'calc(13px * var(--font-scale))' }}>
                    <span style={{ color: 'var(--meta)', whiteSpace: 'nowrap' }}>{t('flow.retry')}</span>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={review.maxRetries}
                      onChange={(e) => updateReview(
                        'maxRetries',
                        Math.max(0, Number.parseInt(e.target.value || '0', 10)),
                      )}
                      style={{ width: 48, height: 24, fontSize: 'calc(13px * var(--font-scale))', padding: '0 6px' }}
                    />
                  </div>
                )}
                {review.mode === 'skip' && (
                  <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
                    {t('flow.reviewSkipHint')}
                  </div>
                )}
                {review.mode === 'manual' && (
                  <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
                    {t('flow.reviewPauseHint')}
                  </div>
                )}
              </div>
              {review.mode === 'auto' && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewEngine')}</label>
                      <EngineSelect
                        engines={engines}
                        value={review.engine}
                        onChange={(engineId) => {
                          updateDraft('review', {
                            ...review,
                            engine: engineId,
                            model: '',
                            config: initialStepConfig(engineConfigById(engineId || draft.engine)),
                          })
                        }}
                        disabled={enginesLoading}
                        defaultOption={{ value: '', label: t('flow.inheritStepEngine') }}
                        ariaLabel={t('flow.reviewEngine')}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewModel')}</label>
                      <Select
                        value={review.model}
                        disabled={reviewModelsLoading}
                        onChange={(e) => updateReview('model', e.target.value)}
                      >
                        <option value="">
                          {reviewModelsLoading
                            ? t('flow.modelsLoading')
                            : review.engine
                              ? t('flow.reviewEngineDefaultModel')
                              : t('flow.inheritStepModel')}
                        </option>
                        {review.model && !reviewModels.some((model) => model.id === review.model) && (
                          <option value={review.model}>{review.model}{t('flow.currentConfigSuffix')}</option>
                        )}
                        {reviewModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label || model.id}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  {reviewFields.length > 0 && (
                    <div>
                      <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewConfig')}</label>
                      <StepConfigFields
                        engineId={reviewEngine}
                        fields={reviewFields}
                        values={review.config || {}}
                        onChange={(key, value) => updateReviewConfig(key, value)}
                      />
                    </div>
                  )}
                  <div>
                    <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewPrompt')}</label>
                    <MarkdownEditor
                      value={review.prompt}
                      onChange={(v) => updateReview('prompt', v)}
                      projectId={projectId}
                      minHeight={96}
                      maxHeight={200}
                      placeholder={t('flow.reviewPromptPlaceholder')}
                      ariaLabel={t('flow.reviewPromptAria')}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {projectId && workflowId && <WorkflowQuickButtonsSection
          projectId={projectId}
          workflowId={workflowId}
          buttons={draft.quickButtons || []}
          onChange={(buttons) => updateDraft('quickButtons', buttons)}
        />}
      </div>


    </div>
  )
}
