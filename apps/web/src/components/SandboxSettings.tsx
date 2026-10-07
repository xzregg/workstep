import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import type { SandboxSettings as Settings, SandboxStatus } from '../utils/desktopSandbox'
import Button from './Button'
import Input from './Input'
import ConfirmDialog from './ConfirmDialog'
import Spinner from './Spinner'
import SandboxImagePicker from './SandboxImagePicker'
import './SandboxSettings.css'

export default function SandboxSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n()
  const bridge = window.workstepDesktop?.sandbox
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const [draft, setDraft] = useState<Settings>({ enabled: false, root: '', project: '', mounts: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'enable' | 'disable' | 'remove' | 'codex' | 'claude' | 'agents' | null>(null)
  const dirty = Boolean(status && (draft.root !== status.settings.root || draft.project !== status.settings.project || (draft.dockerImage || null) !== (status.settings.dockerImage || null) || Boolean(draft.compatibility) !== Boolean(status.settings.compatibility) || JSON.stringify(draft.mounts) !== JSON.stringify(status.settings.mounts)))
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      if (!bridge) return
      try {
        const result = await bridge.status()
        if (alive) { setStatus(result); timer = setTimeout(poll, 1000) }
      } catch (e) { if (alive) { setError(String(e)); timer = setTimeout(poll, 3000) } }
    }
    if (bridge) {
      bridge.status().then(result => {
        if (alive) { setStatus(result); setDraft(result.settings); timer = setTimeout(poll, 1000) }
      }).catch(e => { if (alive) setError(String(e)) })
    }
    return () => { alive = false; clearTimeout(timer) }
  }, [bridge])
  async function perform(operation: () => Promise<SandboxStatus | void>, replaceDraft = false) {
    setBusy(true); setError('')
    try {
      const result = await operation()
      if (result) { setStatus(result); if (replaceDraft) setDraft(result.settings) }
      setConfirmation(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function choose(field: 'root' | 'project') {
    if (!bridge) return
    await perform(async () => {
      const selected = await bridge.chooseDirectory()
      if (selected) setDraft(current => ({ ...current, [field]: selected }))
    })
  }
  const runningPhase = status && ['download', 'machine', 'image', 'starting'].includes(status.phase)
  const blocked = busy || Boolean(runningPhase)
  const frozen = blocked || status?.running || status?.settings.enabled
  const prepared = status?.settings.prepared && !dirty
  if (!bridge) return null
  return <div className="sandbox-settings">
    <h1>{t('sandbox.title')}</h1>
    <p>{t('sandbox.description')}</p>
    {status && !status.supported && <p role="alert">{t('sandbox.unsupported')}</p>}
    <div className="sandbox-status" role="status">
      {(blocked || (!status && !error)) && <Spinner />}
      {t(status?.running ? 'sandbox.running' : status?.settings.enabled ? 'sandbox.enabled' : 'sandbox.disabled')}
      {runningPhase && <span>{t(`sandbox.phase.${status!.phase}` as Parameters<typeof t>[0])}</span>}
      {status?.progress && <span>{Math.round(status.progress.received / 1048576)} MiB{status.progress.total ? ` / ${Math.round(status.progress.total / 1048576)} MiB` : ''}</span>}
    </div>
    {!status && error && <Button disabled={busy} onClick={() => void perform(() => bridge.status(), true)}>{t('common.retry')}</Button>}
    <SandboxImagePicker value={draft.dockerImage || null} online={status?.onlineImage !== false} disabled={Boolean(frozen)} scan={bridge.dockerImages} onChange={dockerImage => setDraft(current => ({ ...current, dockerImage }))} />
    <label htmlFor="sandbox-root">{t('sandbox.root')}</label>
    <div className="sandbox-directory"><Input id="sandbox-root" readOnly value={draft.root} /><Button disabled={Boolean(frozen)} onClick={() => void choose('root')}>{t('sandbox.choose')}</Button></div>
    <label htmlFor="sandbox-project">{t('sandbox.project')}</label>
    <div className="sandbox-directory"><Input id="sandbox-project" readOnly value={draft.project} /><Button disabled={Boolean(frozen)} onClick={() => void choose('project')}>{t('sandbox.choose')}</Button></div>
    <h2>{t('sandbox.mounts')}</h2>
    {draft.mounts.map((mount, i) => <div className="sandbox-mount" key={i}>
      <Input readOnly value={mount.source} aria-label={t('sandbox.source')} />
      <Input value={mount.target} disabled={Boolean(frozen)} aria-label={t('sandbox.target')} onChange={e => setDraft(current => ({ ...current, mounts: current.mounts.map((m, index) => index === i ? { ...m, target: e.target.value } : m) }))} />
      <Button disabled={Boolean(frozen)} onClick={() => setDraft(current => ({ ...current, mounts: current.mounts.filter((_, index) => index !== i) }))}>{t('sandbox.removeMount')}</Button>
    </div>)}
    <Button disabled={Boolean(frozen)} onClick={() => void perform(async () => {
      const source = await bridge.chooseDirectory()
      if (source) setDraft(current => ({ ...current, mounts: [...current.mounts, { source, target: `/data/projects/extra-${current.mounts.length + 1}` }] }))
    })}>{t('sandbox.addMount')}</Button>
    <label className="sandbox-checkbox"><input type="checkbox" checked={Boolean(draft.compatibility)} disabled={Boolean(frozen)} onChange={e => setDraft(current => ({ ...current, compatibility: e.target.checked }))} />{t('sandbox.compatibility')}</label>
    <p>{t('sandbox.compatibilityDescription')}</p>
    <div className="sandbox-actions">
      <Button loading={busy && !confirmation} disabled={Boolean(frozen) || !status?.supported || (!draft.dockerImage && status?.onlineImage === false) || !draft.root || !draft.project || draft.mounts.some(m => !m.target)} onClick={() => void perform(() => bridge.prepare(draft), true)}>{t('sandbox.prepare')}</Button>
      <Button disabled={blocked || !prepared} onClick={() => setConfirmation(status?.settings.enabled ? 'disable' : 'enable')}>{t(status?.settings.enabled ? 'sandbox.disable' : 'sandbox.enable')}</Button>
      <Button disabled={blocked || !draft.root} onClick={() => void perform(() => bridge.logs())}>{t('sandbox.logs')}</Button>
    </div>
    <h2>{t('sandbox.importTitle')}</h2><p>{t('sandbox.importDescription')}</p>
    <div className="sandbox-actions">{(['codex', 'claude', 'agents'] as const).map(kind => <Button key={kind} disabled={blocked || !prepared || Boolean(status?.running)} onClick={() => setConfirmation(kind)}>{t(`sandbox.import.${kind}`)}</Button>)}</div>
    <p>{t('sandbox.pathsNotice')}</p>
    <Button variant="danger" disabled={blocked || !status?.settings.root || status.settings.enabled || status.running} onClick={() => setConfirmation('remove')}>{t('sandbox.delete')}</Button>
    {(error || status?.error) && <p className="sandbox-error" role="alert">{error || status?.error}</p>}
    <ConfirmDialog open={Boolean(confirmation)} title={t(confirmation === 'remove' ? 'sandbox.delete' : confirmation === 'enable' || confirmation === 'disable' ? 'sandbox.switchTitle' : 'sandbox.importTitle')}
      message={t(confirmation === 'remove' ? 'sandbox.deleteConfirm' : confirmation === 'enable' || confirmation === 'disable' ? 'sandbox.switchConfirm' : 'sandbox.importConfirm')}
      danger={confirmation === 'remove'} loading={busy} onCancel={() => { if (!busy) setConfirmation(null) }}
      onConfirm={() => void perform(() => confirmation === 'remove' ? bridge.remove() : confirmation === 'enable' || confirmation === 'disable' ? bridge.switchMode(confirmation === 'enable') : bridge.importConfig(confirmation as 'codex' | 'claude' | 'agents'), confirmation === 'remove')} />
  </div>
}
