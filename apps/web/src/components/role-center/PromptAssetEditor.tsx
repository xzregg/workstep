import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { roleCenterApi, type RoleCatalog, type RoleDocument, type TeamDocument, type TeamMember } from '../../api/roleCenter'
import { useI18n } from '../../i18n'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import { useOverlay } from '../../hooks/useOverlay'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import Field from '../Field'
import Input from '../Input'
import MarkdownEditor from '../MarkdownEditor'
import ResizablePanel from '../ResizablePanel'
import Select from '../Select'
import Spinner from '../Spinner'
import RoleMemberPicker from './RoleMemberPicker'

interface Draft { name: string; description: string; prompt: string; category: string; members: TeamMember[] }
interface Props {
  kind: 'role' | 'team'; id: string | null; catalog: RoleCatalog
  onSaved: (record: RoleDocument | TeamDocument) => void; onClose: () => void
  onDirtyChange?: (dirty: boolean) => void
}

export default function PromptAssetEditor({ kind, id, catalog, onSaved, onClose, onDirtyChange }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const panel = useRef<HTMLDivElement>(null)
  const initial: Draft = { name: '', category: catalog.categories[0]?.id || 'custom-role', description: '', prompt: '', members: [] }
  const [draft, setDraft] = useState(initial)
  const [baseline, setBaseline] = useState(JSON.stringify(initial))
  const [record, setRecord] = useState<RoleDocument | TeamDocument | null>(null)
  const [loading, setLoading] = useState(Boolean(id))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [confirm, setConfirm] = useState(false)
  const [memberRatio, setMemberRatio] = useState(.5)
  const dirty = JSON.stringify(draft) !== baseline
  const mounted = useRef(true)
  const title = t(kind === 'role' ? id ? 'roleCenter.editRole' : 'roleCenter.newRole' : id ? 'roleCenter.editTeam' : 'roleCenter.newTeam')
  const close = () => { if (saving) return; if (dirty) setConfirm(true); else onClose() }
  useOverlay(true, close, panel, compact)

  useEffect(() => {
    let active = true
    if (!id) return () => { active = false }
    setLoading(true); setError('')
    const load = kind === 'role' ? roleCenterApi.getRole(id) : roleCenterApi.getTeam(id)
    load.then(data => {
      if (!active) return
      const next = { name: data.name, description: data.description, prompt: data.prompt,
        category: 'category' in data ? data.category : '', members: 'members' in data ? data.members : [] }
      setRecord(data); setDraft(next); setBaseline(JSON.stringify(next)); setLoading(false)
    }).catch(reason => { if (active) { setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)) } })
    return () => { active = false }
  }, [kind, id, retry])

  useEffect(() => { onDirtyChange?.(dirty || saving) }, [dirty, saving, onDirtyChange])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirtyChange?.(false) } }, [onDirtyChange])

  const valid = Boolean(draft.name.trim() && (kind === 'role' ? draft.prompt.trim() && draft.category : draft.members.length))
  const change = (values: Partial<Draft>) => { setDraft(current => ({ ...current, ...values })); setError('') }
  const save = async () => {
    if (!valid || saving || loading || (id && !record)) return
    setSaving(true); setError('')
    try {
      const fields = { name: draft.name.trim(), description: draft.description, prompt: draft.prompt, expected_revision: record?.revision || '' }
      const result = kind === 'role'
        ? await roleCenterApi.saveRole({ ...fields, category: draft.category }, id || undefined)
        : await roleCenterApi.saveTeam({ ...fields, members: draft.members }, id || undefined)
      if (mounted.current) onSaved(result)
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : t('roleCenter.saveFailed')) }
    finally { if (mounted.current) setSaving(false) }
  }
  const promptLabel = t(kind === 'role' ? 'roleCenter.rolePrompt' : 'roleCenter.teamPrompt')

  return createPortal(<div className="modal-overlay role-center-editor-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <ResizablePanel ref={panel} className="modal role-center-editor-panel" role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><span className="modal-title">{title}</span>
        <Button variant="icon" disabled={saving} aria-label={t(kind === 'role' ? 'roleCenter.closeRole' : 'roleCenter.closeTeam')} onClick={close}>✕</Button>
      </header>
      {loading ? <div className="role-center-loading"><Spinner />{t('roleCenter.loading')}</div>
        : id && !record ? <div className="role-center-load-error"><p className="role-center-editor-error" role="alert">{error}</p>
          <Button onClick={() => setRetry(r => r + 1)}>{t('roleCenter.retry')}</Button></div>
        : <div className="role-center-editor-body">
          <div className="role-center-editor-meta">
            <Field label={t(kind === 'role' ? 'roleCenter.roleName' : 'roleCenter.teamName')} required htmlFor="role-center-name">
              <Input id="role-center-name" aria-label={t(kind === 'role' ? 'roleCenter.roleName' : 'roleCenter.teamName')}
                value={draft.name} maxLength={160} disabled={saving} onChange={event => change({ name: event.target.value })} />
            </Field>
            {kind === 'role' && <Field label={t('roleCenter.category')} htmlFor="role-center-category">
              <Select id="role-center-category" value={draft.category} disabled={saving} onChange={event => change({ category: event.target.value })}>
                {catalog.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                {!catalog.categories.some(c => c.id === 'custom-role') && <option value="custom-role">{t('roleCenter.customCategory')}</option>}
              </Select>
            </Field>}
            <Field label={t(kind === 'role' ? 'roleCenter.description' : 'roleCenter.teamPurpose')} htmlFor="role-center-description">
              <Input id="role-center-description" value={draft.description} maxLength={4000} disabled={saving} onChange={event => change({ description: event.target.value })} />
            </Field>
          </div>
          <div className={`role-center-editor-content${kind === 'team' ? ' role-center-editor-content--team' : ''}`}
            style={kind === 'team' && !compact ? { gridTemplateColumns: `${memberRatio}fr 8px ${1 - memberRatio}fr` } : undefined}>
            {kind === 'team' && <RoleMemberPicker catalog={catalog} members={draft.members} disabled={saving} onChange={members => change({ members })} />}
            {kind === 'team' && !compact && <button type="button" className="role-center-split-handle" role="separator"
              aria-label={t('roleCenter.resizeColumns')} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75}
              aria-valuenow={Math.round(memberRatio * 100)}
              onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }}
              onPointerMove={event => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
                setMemberRatio(Math.min(.75, Math.max(.25, (event.clientX - bounds.left) / Math.max(1, bounds.width))))
              }} onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                setMemberRatio(value => Math.min(.75, Math.max(.25, value + (event.key === 'ArrowLeft' ? -.02 : .02))))
              }}>⋮</button>}
            <div className="role-center-prompt"><h2>{promptLabel}</h2>
              <p>{t(kind === 'role' ? 'roleCenter.rolePromptHint' : 'roleCenter.teamPromptHint')}</p>
              <MarkdownEditor value={draft.prompt} disabled={saving} onChange={prompt => change({ prompt })}
                ariaLabel={promptLabel} maxLength={200000} allowAttachments={false} />
            </div>
          </div>
          {record && 'source' in record && record.source && <details className="role-center-source"><summary>{t('roleCenter.source')}</summary>
            <p>{record.source.repository}</p><p>{record.source.path}</p><p>{record.source.commit} · {record.source.license}</p>
          </details>}
        </div>}
      <footer className="role-center-editor-footer">
        <div className="role-center-editor-error" role="alert">{record || !id ? error : ''}</div>
        <div className="role-center-editor-actions"><span>{t('roleCenter.localOnly')}</span>
          <Button onClick={close} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={loading || !valid || Boolean(id && (!record || !dirty))} onClick={() => void save()}>
            {t(kind === 'role' ? id ? 'roleCenter.saveRole' : 'roleCenter.createRole' : id ? 'roleCenter.saveTeam' : 'roleCenter.createTeam')}
          </Button>
        </div>
      </footer>
    </ResizablePanel>
    <ConfirmDialog open={confirm} title={t('roleCenter.discardTitle')} message={t('roleCenter.discardHint')}
      confirmText={t('roleCenter.discard')} cancelText={t('roleCenter.keepEditing')} onCancel={() => setConfirm(false)} onConfirm={onClose} />
  </div>, document.body)
}
