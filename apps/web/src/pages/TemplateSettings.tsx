import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Button from '../components/Button'
import FlowCanvas, { type FlowCanvasHandle } from '../components/FlowCanvas'
import AiFlowEditorPanel from '../components/AiFlowEditorPanel'
import ConfirmDialog from '../components/ConfirmDialog'
import Field from '../components/Field'
import Input from '../components/Input'
import {
  fetchTemplates,
  invalidateTemplates,
  templateApi,
  type TemplateInfo,
} from '../api/client'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'

const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/* ══════════════════════════════════════════
   Settings → Workflow Templates
   List / create / edit / delete workflow
   templates. Editing uses the reusable FlowCanvas
   (same canvas as the workflow editor) and saves
   via the daemon template API.
   ══════════════════════════════════════════ */

export default function TemplateSettings() {
  const { t } = useI18n()
  const activeProject = useProjectStore((state) => state.activeProject)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<TemplateInfo | null>(null)
  const [canvasDirty, setCanvasDirty] = useState(false)
  const [metaDirty, setMetaDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [meta, setMeta] = useState({ id: '', name: '', description: '' })
  const [createOpen, setCreateOpen] = useState(false)
  const [newDraft, setNewDraft] = useState({ id: '', name: '', description: '' })
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<TemplateInfo | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiGenBusy, setAiGenBusy] = useState(false)
  const [aiConfirmClose, setAiConfirmClose] = useState(false)
  const [pendingAiSteps, setPendingAiSteps] = useState<any>(null)
  const canvasRef = useRef<FlowCanvasHandle>(null)

  // Dirty when either the canvas (FlowCanvas) or metadata (name/desc/id) changed
  const editorDirty = canvasDirty || metaDirty

  const requestCloseAiPanel = () => {
    if (aiGenBusy) { setAiConfirmClose(true); return }
    setAiPanelOpen(false)
  }

  const toggleAiPanel = () => {
    if (aiPanelOpen) {
      requestCloseAiPanel()
      return
    }
    setAiPanelOpen(true)
    setAiConfirmClose(false)
  }

  const refresh = useCallback(async (force = false) => {
    try {
      const { templates: list } = await fetchTemplates(force)
      setTemplates(list)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('templateSettings.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const openEditor = async (template: TemplateInfo) => {
    setError('')
    try {
      const full = await templateApi.get(template.id)
      setEditing({ ...full, custom: Boolean(template.custom) })
      setMeta({
        id: full.id || '',
        name: full.name || '',
        description: full.description || '',
      })
      setCanvasDirty(false)
      setMetaDirty(false)
      setAiPanelOpen(false)
      setAiConfirmClose(false)
      setPendingAiSteps(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('templateSettings.loadTemplateFailed'))
    }
  }

  const closeEditor = () => {
    setEditing(null)
    setCanvasDirty(false)
    setMetaDirty(false)
    setAiPanelOpen(false)
    setAiConfirmClose(false)
    setPendingAiSteps(null)
  }

  const metaError = (() => {
    if (!editing) return ''
    const id = meta.id.trim()
    if (!id) return ''
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      return t('templateSettings.idPattern')
    }
    if (templates.some((template) => template.id === id && template.id !== editing.id)) {
      return t('templateSettings.idDuplicate', { id })
    }
    return ''
  })()

  const saveTemplate = async (steps: any) => {
    const id = meta.id.trim()
    const name = meta.name.trim()
    if (!id) throw new Error(t('templateSettings.idRequired'))
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      throw new Error(t('templateSettings.idPattern'))
    }
    if (!name) throw new Error(t('templateSettings.nameRequired'))
    if (id !== editing?.id && templates.some((template) => template.id === id)) {
      throw new Error(t('templateSettings.idDuplicate', { id }))
    }
    const description = meta.description.trim()
    await templateApi.save({ id, name, description, steps })
    setEditing((prev) => (prev ? { ...prev, id, name, description, steps, custom: true } : prev))
    setMeta((m) => ({ ...m, id, name, description }))
    setMetaDirty(false)
    invalidateTemplates()
    await refresh(true)
  }

  const createTemplate = async () => {
    const id = newDraft.id.trim()
    const name = newDraft.name.trim()
    const description = newDraft.description.trim()
    if (!id) { setCreateError(t('templateSettings.enterId')); return }
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      setCreateError(t('templateSettings.idPatternShort'))
      return
    }
    if (templates.some((template) => template.id === id)) {
      setCreateError(t('templateSettings.idDuplicate', { id }))
      return
    }
    if (!name) { setCreateError(t('templateSettings.enterName')); return }
    setCreating(true)
    try {
      await templateApi.save({ id, name, description, steps: { nodes: [], connections: [] } })
      setCreateOpen(false)
      setNewDraft({ id: '', name: '', description: '' })
      setCreateError('')
      invalidateTemplates()
      await refresh(true)
      await openEditor({ id, name, description, nodeCount: 0, custom: true })
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : t('templateSettings.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  const deleteTemplate = async () => {
    if (!deleting) return
    setDeletingBusy(true)
    try {
      await templateApi.del(deleting.id)
      setDeleting(null)
      invalidateTemplates()
      await refresh(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('templateSettings.deleteFailed'))
      setDeleting(null)
    } finally {
      setDeletingBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>{t('templateSettings.title')}</h1>
          <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>
            {t('templateSettings.introPart1')} <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'calc(13px * var(--font-scale))' }}>~/.workstep/data/templates/</code>{' '}
            {t('templateSettings.introPart2')}<code style={{ fontFamily: 'var(--font-mono)', fontSize: 'calc(13px * var(--font-scale))' }}>default: true</code>{t('templateSettings.introPart3')}
          </p>
        </div>
        <Button variant="primary" onClick={() => { setCreateOpen(true); setCreateError('') }}>
          {t('templateSettings.newTemplate')}
        </Button>
      </div>

      {error && (
        <div style={{ marginBottom: 12, fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)' }}>{error}</div>
      )}

      {loading ? (
        <div style={{ padding: '18px 4px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>{t('templateSettings.loading')}</div>
      ) : templates.length === 0 ? (
        <div style={{ padding: '18px 4px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>{t('templateSettings.noTemplates')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map((template) => (
            <div
              key={template.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{template.name}</span>
                  <span style={{
                    fontSize: 'calc(11px * var(--font-scale))', padding: '1px 7px', borderRadius: 99, flexShrink: 0,
                    background: template.custom
                      ? (template.default
                        ? 'color-mix(in oklab, var(--success), transparent 90%)'
                        : 'color-mix(in oklab, var(--accent), transparent 88%)')
                      : 'var(--surface)',
                    color: template.custom ? (template.default ? 'var(--success)' : 'var(--accent)') : 'var(--muted)',
                    border: '1px solid var(--border-soft)',
                  }}>
                    {template.custom ? (template.default ? t('layout.default') : t('templateSettings.custom')) : t('templateSettings.builtin')}
                  </span>
                </div>
                {template.description && (
                  <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {template.description}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', flexShrink: 0 }}>{t('templateSettings.nodeCount', { count: template.nodeCount })}</span>
              <Button variant="ghost" style={{ height: 28, padding: '0 10px', fontSize: 'calc(13px * var(--font-scale))' }} onClick={() => void openEditor(template)}>
                {t('common.edit')}
              </Button>
              {template.custom && !template.default && (
                <Button variant="ghost" style={{ height: 28, padding: '0 10px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)' }} onClick={() => setDeleting(template)}>
                  {t('common.delete')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* New template modal */}
      {createOpen && (
        <div className="modal-overlay" style={{ zIndex: 300 }} onClick={() => setCreateOpen(false)}>
          <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('templateSettings.createTitle')}</span>
              <Button variant="icon" aria-label={t('common.close')} onClick={() => setCreateOpen(false)}>✕</Button>
            </div>
            <div className="modal-body">
              <Field label={t('templateSettings.idField')} htmlFor="tpl-id" error={createError}>
              <Input
                id="tpl-id"
                value={newDraft.id}
                onChange={(e) => { setNewDraft({ ...newDraft, id: e.target.value }); setCreateError('') }}
                placeholder={t('templateSettings.idPlaceholder')}
                autoFocus
              />
              </Field>
              <Field label={t('templateSettings.nameField')} htmlFor="tpl-name">
              <Input
                id="tpl-name"
                value={newDraft.name}
                onChange={(e) => { setNewDraft({ ...newDraft, name: e.target.value }); setCreateError('') }}
                placeholder={t('templateSettings.namePlaceholder')}
              />
              </Field>
              <Field label={t('templateSettings.descField')} htmlFor="tpl-desc">
              <Input
                id="tpl-desc"
                value={newDraft.description}
                onChange={(e) => { setNewDraft({ ...newDraft, description: e.target.value }); setCreateError('') }}
                placeholder={t('templateSettings.descPlaceholder')}
              />
              </Field>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={creating} loading={creating} onClick={() => void createTemplate()}>
                {t('templateSettings.createAndEdit')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Template editor overlay — portaled to body so the settings modal's
          overflow/backdrop-filter cannot clip the fullscreen canvas */}
      {editing && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
          <div style={{
            height: 48, background: 'var(--bg)', borderBottom: '1px solid var(--border-soft)',
            display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px', flexShrink: 0,
          }}>
            <Button
              variant="ghost"
              aria-label={t('templateSettings.backAria')}
              title={t('templateSettings.backTitle')}
              onClick={() => { if (editorDirty) { setConfirmClose(true); return } closeEditor() }}
              style={{ height: 30, padding: '0 9px' }}
            >
              {t('templateSettings.back')}
            </Button>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'calc(13px * var(--font-scale))', whiteSpace: 'nowrap' }}>
              {t('templateSettings.metaTitle')}
            </span>
            {editing.default ? (
              <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>{t('templateSettings.defaultMetaHint')}</span>
            ) : (
              <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>{t('templateSettings.customMetaHint')}</span>
            )}
            <div style={{ flex: 1 }} />
            <Input
              value={meta.id}
              onChange={(e) => { setMeta({ ...meta, id: e.target.value }); setMetaDirty(true) }}
              placeholder={t('templateSettings.idPlaceholderShort')}
              title={t('templateSettings.idTitle')}
              spellCheck={false}
              style={{ width: 150, height: 28 }}
            />
            <Input
              value={meta.name}
              onChange={(e) => { setMeta({ ...meta, name: e.target.value }); setMetaDirty(true) }}
              placeholder={t('templateSettings.namePlaceholderShort')}
              title={t('templateSettings.nameTitle')}
              style={{ width: 170, height: 28 }}
            />
            <Input
              value={meta.description}
              onChange={(e) => { setMeta({ ...meta, description: e.target.value }); setMetaDirty(true) }}
              placeholder={t('templateSettings.descPlaceholderShort')}
              title={t('templateSettings.descTitle')}
              style={{ width: 220, height: 28 }}
            />
            {metaDirty && <span style={{ color: 'var(--warn-text)', fontSize: 'calc(11px * var(--font-scale))', whiteSpace: 'nowrap' }}>{t('templateSettings.metaUnsaved')}</span>}
          </div>
          {metaError && (
            <div style={{
              padding: '6px 14px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)', flexShrink: 0,
              background: 'color-mix(in oklab, var(--danger), transparent 92%)',
              borderBottom: '1px solid var(--border-soft)',
            }}>
              {metaError}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <FlowCanvas
                ref={canvasRef}
                initialSteps={editing.steps || { nodes: [], connections: [] }}
                onSave={saveTemplate}
                onDirtyChange={setCanvasDirty}
                showTemplatePicker={false}
                title={t('templateSettings.editorTitle')}
                saveLabel={t('flow.saveTemplate')}
                hint={null}
                toolbarMid={
                  <Button
                    variant="ghost"
                    title={t('templateSettings.aiEditTitle')}
                    aria-expanded={aiPanelOpen}
                    onClick={toggleAiPanel}
                    style={{ height: 28, fontSize: 'calc(13px * var(--font-scale))', whiteSpace: 'nowrap' }}
                  >
                    {t('canvas.aiEdit')}
                  </Button>
                }
              />
            </div>
            {aiPanelOpen && (
              <AiFlowEditorPanel
                projectId={activeProject?.id || ''}
                workflowId={`template:${editing.id}`}
                workflowName={meta.name}
                getCanvasSteps={() => canvasRef.current?.getSteps()}
                onProposal={(steps) => {
                  if (canvasDirty) { setPendingAiSteps(steps); return }
                  canvasRef.current?.loadSteps(steps)
                }}
                onRestore={(steps) => canvasRef.current?.loadSteps(steps)}
                onBusyChange={setAiGenBusy}
                onRequestClose={requestCloseAiPanel}
                title={t('templateSettings.aiEditTitle')}
              />
            )}
          </div>
        </div>,
        document.body,
      )}

      {createPortal(
        <>
          <ConfirmDialog
            open={aiConfirmClose}
            title={t('canvas.aiGeneratingTitle')}
            message={t('canvas.aiGeneratingMessage')}
            confirmText={t('common.close')}
            onConfirm={() => { setAiConfirmClose(false); setAiPanelOpen(false) }}
            onCancel={() => setAiConfirmClose(false)}
          />

          <ConfirmDialog
            open={pendingAiSteps !== null}
            title={t('canvas.proposalOverwriteTitle')}
            message={t('canvas.proposalOverwriteMessage')}
            confirmText={t('canvas.applyProposal')}
            danger
            onConfirm={() => {
              if (pendingAiSteps !== null) canvasRef.current?.loadSteps(pendingAiSteps)
              setPendingAiSteps(null)
            }}
            onCancel={() => setPendingAiSteps(null)}
          />

          {/* Unsaved changes confirm */}
          <ConfirmDialog
            open={confirmClose}
            title={t('canvas.unsavedTitle')}
            message={t('templateSettings.unsavedMessage')}
            confirmText={t('layout.discardChanges')}
            danger
            onConfirm={() => { setConfirmClose(false); closeEditor() }}
            onCancel={() => setConfirmClose(false)}
          />

          {/* Delete template confirm */}
          <ConfirmDialog
            open={deleting !== null}
            title={t('templateSettings.deleteTitle')}
            message={deleting ? t('templateSettings.deleteMessage', { name: deleting.name }) : undefined}
            confirmText={t('common.delete')}
            danger
            onConfirm={() => void deleteTemplate()}
            onCancel={() => { if (!deletingBusy) setDeleting(null) }}
          />
        </>,
        document.body,
      )}
    </div>
  )
}
