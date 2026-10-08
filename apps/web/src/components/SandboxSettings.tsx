import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import type { SandboxSettings as Settings, SandboxStatus, HostSandboxProject, SandboxMigrationOptions } from '../utils/desktopSandbox'
import Button from './Button'
import Input from './Input'
import ConfirmDialog from './ConfirmDialog'
import Spinner from './Spinner'
import SandboxImagePicker from './SandboxImagePicker'
import './SandboxSettings.css'

const empty: Settings = { enabled: false, root: '', project: '', mounts: [] }
const defaults: SandboxMigrationOptions = { providers: true, engines: true, preferences: true, overwrite: false }
const steps = ['software', 'images', 'projects', 'migration', 'confirm'] as const
const phases = ['download', 'machine', 'image', 'caching', 'starting', 'migration']
type Confirmation = 'enable' | 'disable' | 'remove' | 'migrate' | 'discard' | 'codex' | 'claude' | 'agents'

export default function SandboxSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n()
  const bridge = window.workstepDesktop?.sandbox
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const [draft, setDraft] = useState<Settings>(empty)
  const [catalog, setCatalog] = useState<HostSandboxProject[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [projectMode, setProjectMode] = useState<'existing' | 'new'>('existing')
  const [migration, setMigration] = useState(defaults)
  const [step, setStep] = useState(0)
  const [management, setManagement] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ack, setAck] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [diagnosticLogs, setDiagnosticLogs] = useState<string | null>(null)
  const [changingImage, setChangingImage] = useState(false)
  const dirty = Boolean(status && (!management && (draft.root !== status.settings.root || draft.project !== status.settings.project || (draft.dockerImage || null) !== (status.settings.dockerImage || null) || Boolean(draft.compatibility) !== Boolean(status.settings.compatibility) || JSON.stringify(draft.mounts) !== JSON.stringify(status.settings.mounts) || JSON.stringify(selected) !== JSON.stringify(status.settings.registeredProjects || catalog.map(p => p.path)) || (step >= 3 && JSON.stringify(migration) !== JSON.stringify(defaults)))))
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  useEffect(() => {
    if (!bridge) return
    setError('')
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try { const result = await bridge!.status(); if (alive) setStatus(result) }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)) }
      if (alive) timer = setTimeout(poll, 1000)
    }
    Promise.all([bridge.status(), bridge.hostProjects()]).then(([result, projects]) => {
      if (!alive) return
      setStatus(result); setDraft(result.settings); setCatalog(projects)
      setSelected(result.settings.registeredProjects || projects.map(p => p.path))
      setProjectMode(projects.length && result.settings.registeredProjects?.length !== 0 ? 'existing' : 'new')
      setManagement(Boolean(result.settings.prepared))
      timer = setTimeout(poll, 1000)
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false; clearTimeout(timer) }
  }, [bridge, loadAttempt])
  const blocked = busy || Boolean(status && phases.includes(status.phase))
  const frozen = blocked || Boolean(status?.running || status?.settings.enabled)
  const runtimeReady = Boolean(status?.runtimeReady || status?.settings.prepared) && draft.root === status?.settings.root
  const imageReady = runtimeReady && Boolean(status?.imageReady || status?.settings.prepared) && (draft.dockerImage || null) === (status?.cachedDockerImage || status?.settings.dockerImage || null)
  const canContinue = status?.supported && !blocked && (step === 0 ? runtimeReady : step === 1 ? imageReady : step === 2 ? projectMode === 'existing' ? selected.length > 0 : Boolean(draft.project && draft.mounts.every(m => m.target)) : true)
  const hasMigration = migration.providers || migration.engines || migration.preferences
  async function perform(operation: () => Promise<SandboxStatus | void>, replaceDraft = false) {
    setBusy(true); setError('')
    try {
      const result = await operation()
      if (result) { setStatus(result); if (replaceDraft) setDraft(result.settings) }
      setConfirmation(null)
      return true
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false }
    finally { setBusy(false) }
  }
  async function choose(field: 'root' | 'project') {
    if (!bridge) return
    await perform(async () => {
      const value = await bridge.chooseDirectory()
      if (value) { setDraft(d => ({ ...d, [field]: value })); setAck(false) }
    })
  }
  function configuration(): Settings {
    if (projectMode === 'new') return { ...draft, registeredProjects: [] }
    return { ...draft, project: selected[0] || '', mounts: selected.slice(1).map((source, index) => ({ source, target: `/data/projects/project-${index + 2}` })), registeredProjects: selected }
  }
  async function finish(enable: boolean) {
    if (!bridge) return
    const success = await perform(async () => {
      const prepared = await bridge.prepare(configuration())
      setStatus(prepared); setDraft(prepared.settings)
      const result = hasMigration ? await bridge.migrateSettings(migration) : prepared
      setStatus(result)
      if (enable) await bridge.switchMode(true)
      return result
    }, true)
    if (success) { setManagement(true); setAck(false) }
  }
  function edit(nextStep: number) { setManagement(false); setStep(nextStep); setAck(false); setError('') }
  function check(ready: boolean, label: string) {
    return <div className="sandbox-check-row"><span className={`sandbox-check-symbol${ready ? ' sandbox-check-symbol--ready' : ''}`} aria-hidden="true">{ready ? '✓' : '○'}</span><span>{label}</span>{blocked && <Spinner />}</div>
  }
  const notice = <div className="sandbox-notice"><strong>{t('sandbox.wizard.dataTitle')}</strong><p>{t('sandbox.wizard.dataHint')}</p></div>
  const migrationFields = <>
    {(['providers', 'engines', 'preferences'] as const).map(key => <label className="sandbox-option" key={key}><input type="checkbox" checked={migration[key]} disabled={frozen} onChange={e => { setMigration(m => ({ ...m, [key]: e.target.checked })); setAck(false) }} /><span><strong>{t(`sandbox.wizard.${key}`)}</strong><p>{t(`sandbox.wizard.${key}Hint`)}</p></span></label>)}
    <div className="sandbox-excluded"><strong>{t('sandbox.wizard.excluded')}</strong><p>{t('sandbox.wizard.excludedHint')}</p></div>
    <div className="sandbox-notice"><strong>{t('sandbox.wizard.localAddress')}</strong><p>{t('sandbox.wizard.localAddressHint')}</p></div>
    <p className="sandbox-help">{t('sandbox.wizard.cliHint')}</p>
    <details className="sandbox-advanced"><summary>{t('sandbox.wizard.keepExisting')}</summary><label className="sandbox-checkbox"><input type="checkbox" checked={Boolean(migration.overwrite)} disabled={frozen} onChange={e => { setMigration(m => ({ ...m, overwrite: e.target.checked })); setAck(false) }} />{t('sandbox.wizard.overwrite')}</label></details>
  </>
  if (!bridge) return null
  return <div className="sandbox-settings">
    <header className="sandbox-heading"><div><h1>{t('sandbox.title')}</h1><p>{t('sandbox.wizard.intro')}</p></div><span className={`sandbox-mode-chip${status?.running ? ' sandbox-mode-chip--running' : ''}`}>{t(status?.running ? 'sandbox.running' : status?.settings.enabled ? 'sandbox.enabled' : 'sandbox.disabled')}</span></header>
    {!status ? <div className="sandbox-loading">{!error && <Spinner />}<p>{error || t('sandbox.wizard.loading')}</p>{error && <Button loading={busy} onClick={() => setLoadAttempt(value => value + 1)}>{t('common.retry')}</Button>}</div> : <>
      {!status.supported && <p className="sandbox-error" role="alert">{t('sandbox.unsupported')}</p>}
      <div className="sandbox-wizard">
        {!management && <nav className="sandbox-steps" aria-label={t('sandbox.title')}>{steps.map((name, index) => <Button key={name} className={`sandbox-step${step === index ? ' sandbox-step--active' : step > index ? ' sandbox-step--done' : ''}`} disabled={blocked || index > step} aria-current={step === index ? 'step' : undefined} onClick={() => { setStep(index); setError('') }}><span className="sandbox-step-number">{step > index ? '✓' : index + 1}</span>{t(`sandbox.wizard.${name}`)}</Button>)}</nav>}
        <div className="sandbox-wizard-body">
          {management ? <>
            <h2>{t('sandbox.wizard.manageTitle')}</h2><p className="sandbox-step-intro">{t('sandbox.wizard.manageHint')}</p>
            <dl className="sandbox-runtime-status"><div><dt>{t('sandbox.runtimeState')}</dt><dd>{t(`sandbox.health.${status.health || (status.running ? 'healthy' : 'stopped')}` as Parameters<typeof t>[0])}</dd></div><div><dt>{t('sandbox.currentPhase')}</dt><dd>{status.phase === 'error' ? t('sandbox.health.failed') : t(`sandbox.phase.${(status.phase in { download: 1, machine: 1, image: 1, caching: 1, migration: 1, starting: 1, running: 1 }) ? status.phase : 'ready'}` as Parameters<typeof t>[0])}</dd></div><div><dt>{t('sandbox.backendPort')}</dt><dd>{status.hostPort || '—'}</dd></div><div><dt>{t('sandbox.logDirectory')}</dt><dd className="sandbox-path">{status.logDirectory || '—'}</dd></div></dl>
            <div className="sandbox-manage-grid"><section><h3>{t('sandbox.wizard.images')}</h3><p className="sandbox-path">{status.cachedDockerImage || status.settings.dockerImage || t('sandbox.wizard.onlineImage')}</p><Button disabled={blocked} onClick={() => setChangingImage(value => !value)}>{t('sandbox.wizard.manageImage')}</Button></section><section><h3>{t('sandbox.wizard.projects')}</h3><p className="sandbox-path">{status.settings.project}</p><Button disabled={frozen} onClick={() => edit(2)}>{t('sandbox.wizard.manageProjects')}</Button></section><section><h3>{t('sandbox.wizard.migration')}</h3><p>{t('sandbox.wizard.keepExisting')}</p><Button disabled={frozen} onClick={() => edit(3)}>{t('sandbox.wizard.reimport')}</Button></section></div>
            {changingImage && <div className="sandbox-manage-image"><SandboxImagePicker value={draft.dockerImage || null} online={false} disabled={blocked} scan={bridge.dockerImages} onChange={dockerImage => setDraft(value => ({ ...value, dockerImage }))} /><div className="sandbox-actions"><Button variant="primary" loading={busy} disabled={blocked || !draft.dockerImage || draft.dockerImage === status.settings.dockerImage} onClick={() => void perform(() => bridge.switchImage(draft.dockerImage!))}>{t('sandbox.wizard.restart')}</Button><Button disabled={blocked} onClick={() => setChangingImage(false)}>{t('sandbox.wizard.backManage')}</Button></div></div>}
            <div className="sandbox-actions"><Button variant="primary" disabled={blocked || !status.settings.prepared} onClick={() => setConfirmation(status.settings.enabled ? 'disable' : 'enable')}>{t(status.settings.enabled ? 'sandbox.disable' : 'sandbox.enable')}</Button><Button disabled={blocked} onClick={() => void perform(() => bridge.logs())}>{t('sandbox.logs')}</Button><Button disabled={blocked} onClick={() => { if (diagnosticLogs !== null) { setDiagnosticLogs(null); return } setBusy(true); setError(''); void bridge.readLogs().then(setDiagnosticLogs).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)) }}>{t(diagnosticLogs === null ? 'sandbox.wizard.viewLogs' : 'sandbox.wizard.hideLogs')}</Button>{diagnosticLogs !== null && <Button disabled={blocked} onClick={() => void bridge.copyLogs()}>{t('sandbox.wizard.copyLogs')}</Button>}</div>
            {diagnosticLogs !== null && <pre className="sandbox-log-view" tabIndex={0}>{diagnosticLogs || t('sandbox.wizard.logEmpty')}</pre>}
            {(status.running || status.settings.enabled) && <p className="sandbox-help">{t('sandbox.wizard.workHint')}</p>}
            <details className="sandbox-advanced"><summary>{t('sandbox.importTitle')}</summary><p>{t('sandbox.importDescription')}</p><div className="sandbox-actions">{(['codex', 'claude', 'agents'] as const).map(kind => <Button key={kind} disabled={frozen} onClick={() => setConfirmation(kind)}>{t(`sandbox.import.${kind}`)}</Button>)}</div></details>
            <details className="sandbox-advanced"><summary>{t('sandbox.wizard.advanced')}</summary><p className="sandbox-path">{status.settings.root}</p><Button variant="danger" disabled={frozen} onClick={() => setConfirmation('remove')}>{t('sandbox.delete')}</Button></details>
          </> : step === 0 ? <>
            <h2>{t('sandbox.wizard.softwareTitle')}</h2><p className="sandbox-step-intro">{t('sandbox.wizard.softwareHint')}</p>
            <span className="sandbox-platform">{t('sandbox.wizard.platform', { platform: status.platform || '', arch: status.arch || '' })}</span>
            <div className="sandbox-field"><label htmlFor="sandbox-root">{t('sandbox.wizard.storage')}</label><div className="sandbox-directory"><Input id="sandbox-root" readOnly value={draft.root} /><Button disabled={frozen || runtimeReady} onClick={() => void choose('root')}>{t('sandbox.choose')}</Button></div><p className="sandbox-help">{t('sandbox.wizard.storageHint')}</p></div>
            {check(runtimeReady, t(runtimeReady ? 'sandbox.wizard.softwareReady' : 'sandbox.wizard.software'))}
            <Button variant="primary" loading={busy} disabled={frozen || runtimeReady || !status.supported || !draft.root} onClick={() => void perform(async () => { const result = await bridge.prepareRuntime({ root: draft.root }); setDraft(d => ({ ...d, root: result.settings.root })); return result })}>{t('sandbox.wizard.softwareDownload')}</Button>
            {status.platform === 'win32' && <div className="sandbox-notice"><p>{t('sandbox.wizard.wslHelp')}</p><a href="https://learn.microsoft.com/windows/wsl/install" target="_blank" rel="noopener noreferrer">{t('sandbox.wizard.wslGuide')}</a></div>}
          </> : step === 1 ? <>
            <h2>{t('sandbox.wizard.imageTitle')}</h2><p className="sandbox-step-intro">{t('sandbox.wizard.imageHint')}</p>
            <SandboxImagePicker value={draft.dockerImage || null} online={status.onlineImage !== false} disabled={frozen} scan={bridge.dockerImages} onChange={dockerImage => { setDraft(d => ({ ...d, dockerImage })); setAck(false) }} />
            {check(imageReady, t(imageReady ? 'sandbox.wizard.imageReady' : 'sandbox.wizard.images'))}
            <Button variant="primary" loading={busy} disabled={frozen || imageReady || (!draft.dockerImage && status.onlineImage === false)} onClick={() => void perform(() => bridge.prepareImage({ root: draft.root, dockerImage: draft.dockerImage }))}>{t(draft.dockerImage ? 'sandbox.wizard.imagePrepareLocal' : 'sandbox.wizard.imageDownload')}</Button>
            <p className="sandbox-help">{t('sandbox.wizard.imageReuse')}</p>
          </> : step === 2 ? <>
            <h2>{t('sandbox.wizard.projectTitle')}</h2><p className="sandbox-step-intro">{t('sandbox.wizard.projectHint')}</p>
            <div className="sandbox-choices"><label><input type="radio" checked={projectMode === 'existing'} disabled={frozen} onChange={() => setProjectMode('existing')} />{t('sandbox.wizard.existing')}</label><label><input type="radio" checked={projectMode === 'new'} disabled={frozen} onChange={() => setProjectMode('new')} />{t('sandbox.wizard.new')}</label></div>
            {projectMode === 'existing' ? <><div className="sandbox-project-list">{catalog.map(p => <label className="sandbox-project-row" key={p.path}><input type="checkbox" checked={selected.includes(p.path)} disabled={frozen} onChange={e => { setSelected(values => e.target.checked ? [...values, p.path] : values.filter(value => value !== p.path)); setAck(false) }} /><span><strong>{p.name}</strong><span className="sandbox-path">{p.path}</span></span></label>)}</div><Button disabled={frozen} onClick={() => void perform(async () => { const source = await bridge.chooseDirectory(); if (source && !catalog.some(p => p.path === source)) { setCatalog(values => [...values, { path: source, name: source.split(/[\\/]/).filter(Boolean).pop() || source }]); setSelected(values => [...values, source]); setAck(false) } })}>{t('sandbox.wizard.addProject')}</Button><p className="sandbox-help">{t('sandbox.wizard.projectHelp')}</p></> : <>
              {!catalog.length && <p className="sandbox-help">{t('sandbox.wizard.noProjects')}</p>}
              <div className="sandbox-field"><label htmlFor="sandbox-project">{t('sandbox.project')}</label><div className="sandbox-directory"><Input id="sandbox-project" readOnly value={draft.project} /><Button disabled={frozen} onClick={() => void choose('project')}>{t('sandbox.choose')}</Button></div></div>
              <details className="sandbox-advanced"><summary>{t('sandbox.mounts')}</summary>{draft.mounts.map((mount, i) => <div className="sandbox-mount" key={i}><Input readOnly value={mount.source} aria-label={t('sandbox.source')} /><Input value={mount.target} disabled={frozen} aria-label={t('sandbox.target')} onChange={e => setDraft(d => ({ ...d, mounts: d.mounts.map((m, index) => index === i ? { ...m, target: e.target.value } : m) }))} /><Button disabled={frozen} onClick={() => setDraft(d => ({ ...d, mounts: d.mounts.filter((_, index) => index !== i) }))}>{t('sandbox.removeMount')}</Button></div>)}<Button disabled={frozen} onClick={() => void perform(async () => { const source = await bridge.chooseDirectory(); if (source) setDraft(d => ({ ...d, mounts: [...d.mounts, { source, target: `/data/projects/extra-${d.mounts.length + 1}` }] })) })}>{t('sandbox.addMount')}</Button></details>
            </>}
            {notice}
            <details className="sandbox-advanced"><summary>{t('sandbox.wizard.advanced')}</summary><label className="sandbox-checkbox"><input type="checkbox" checked={Boolean(draft.compatibility)} disabled={frozen} onChange={e => setDraft(d => ({ ...d, compatibility: e.target.checked }))} />{t('sandbox.compatibility')}</label><p>{t('sandbox.compatibilityDescription')}</p></details>
          </> : step === 3 ? <>
            <h2>{t('sandbox.wizard.migrationTitle')}</h2><p className="sandbox-step-intro">{t('sandbox.wizard.migrationHint')}</p>{migrationFields}
            {status.settings.prepared && <Button disabled={frozen} onClick={() => setConfirmation('migrate')}>{t('sandbox.wizard.migrateNow')}</Button>}
          </> : <>
            <h2>{t('sandbox.wizard.confirmTitle')}</h2><p className="sandbox-step-intro">{t('sandbox.wizard.confirmHint')}</p>
            <dl className="sandbox-summary"><dt>{t('sandbox.wizard.software')}</dt><dd>{t('sandbox.wizard.softwareReady')}</dd><dt>{t('sandbox.wizard.images')}</dt><dd>{t('sandbox.wizard.imageReady')}</dd><dt>{t('sandbox.wizard.projects')}</dt><dd>{projectMode === 'existing' ? t('sandbox.wizard.selectedProjects', { count: selected.length }) : draft.project}</dd><dt>{t('sandbox.wizard.migration')}</dt><dd>{t(hasMigration ? 'sandbox.wizard.migrationSelected' : 'sandbox.wizard.migrationSkip')}</dd><dt>{t('sandbox.wizard.storage')}</dt><dd>{draft.root}</dd></dl>
            {notice}<label className="sandbox-checkbox sandbox-ack"><input id="sandbox-ack" type="checkbox" checked={ack} disabled={blocked} onChange={e => setAck(e.target.checked)} />{t('sandbox.wizard.ack')}</label>
          </>}
          {blocked && <div className="sandbox-progress" role="status"><Spinner /><span>{t(`sandbox.phase.${(status.phase in { download: 1, machine: 1, image: 1, caching: 1, migration: 1, starting: 1 }) ? status.phase : 'machine'}` as Parameters<typeof t>[0])}</span>{status.progress && <span>{Math.round(status.progress.received / 1048576)} MiB{status.progress.total ? ` / ${Math.round(status.progress.total / 1048576)} MiB` : ''}</span>}</div>}
          {(error || status.error) && <p className="sandbox-error" role="alert">{error || status.error}</p>}
          {Boolean(status.settings.migrationWarnings?.length) && <div className="sandbox-notice">{t('sandbox.wizard.migrationWarnings', { names: status.settings.migrationWarnings!.join('、') })}</div>}
        </div>
        {!management && <footer className="sandbox-wizard-footer"><span>{t('sandbox.wizard.stepCount', { step: step + 1 })}</span><div className="sandbox-actions">{status.settings.prepared && <Button disabled={blocked} onClick={() => { if (dirty) setConfirmation('discard'); else { setManagement(true); setError('') } }}>{t('sandbox.wizard.backManage')}</Button>}{step > 0 && <Button disabled={blocked} onClick={() => { setStep(s => s - 1); setError('') }}>{t('sandbox.wizard.back')}</Button>}{step < 4 ? <Button variant="primary" disabled={!canContinue} onClick={() => { setStep(s => s + 1); setError('') }}>{t('sandbox.wizard.next')}</Button> : <><Button loading={busy && !confirmation} disabled={frozen || !runtimeReady || !imageReady} onClick={() => void finish(false)}>{t('sandbox.wizard.save')}</Button><Button variant="primary" disabled={frozen || !ack || !runtimeReady || !imageReady} onClick={() => setConfirmation('enable')}>{t('sandbox.wizard.restart')}</Button></>}</div></footer>}
      </div>
      {!management && draft.root && <div className="sandbox-actions"><Button disabled={blocked} onClick={() => void perform(() => bridge.logs())}>{t('sandbox.logs')}</Button><Button variant="danger" disabled={frozen || !status.settings.root} onClick={() => setConfirmation('remove')}>{t('sandbox.delete')}</Button></div>}
    </>}
    <ConfirmDialog open={Boolean(confirmation)} title={t(confirmation === 'discard' ? 'sandbox.discard' : confirmation === 'remove' ? 'sandbox.delete' : confirmation === 'enable' || confirmation === 'disable' ? 'sandbox.switchTitle' : 'sandbox.importTitle')}
      message={confirmation === 'discard' ? undefined : t(confirmation === 'remove' ? 'sandbox.deleteConfirm' : confirmation === 'enable' ? 'sandbox.wizard.switchNotice' : confirmation === 'disable' ? 'sandbox.wizard.disableNotice' : confirmation === 'migrate' ? 'sandbox.wizard.migrationConfirm' : 'sandbox.importConfirm')}
      danger={confirmation === 'remove'} loading={busy} onCancel={() => { if (!busy) setConfirmation(null) }}
      onConfirm={() => { if (confirmation === 'discard') { setDraft(status!.settings); setSelected(status!.settings.registeredProjects || catalog.map(p => p.path)); setMigration(defaults); setManagement(true); setConfirmation(null); setError('') } else if (confirmation === 'enable' && !management) void finish(true); else void perform(async () => { if (confirmation === 'remove') { const result = await bridge!.remove(); setManagement(false); setStep(0); setSelected(catalog.map(p => p.path)); return result } if (confirmation === 'enable' || confirmation === 'disable') return bridge!.switchMode(confirmation === 'enable'); if (confirmation === 'migrate') { const result = await bridge!.migrateSettings(migration); setManagement(true); return result } return bridge!.importConfig(confirmation as 'codex' | 'claude' | 'agents') }, confirmation === 'remove') }} />
  </div>
}
