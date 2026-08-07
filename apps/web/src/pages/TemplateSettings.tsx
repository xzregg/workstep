import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Button from '../components/Button'
import FlowCanvas from '../components/FlowCanvas'
import ConfirmDialog from '../components/ConfirmDialog'
import Field from '../components/Field'
import Input from '../components/Input'
import {
  fetchTemplates,
  invalidateTemplates,
  templateApi,
  type TemplateInfo,
} from '../api/client'

const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/* ══════════════════════════════════════════
   Settings → 流程模板
   List / create / edit / delete workflow
   templates. Editing uses the reusable FlowCanvas
   (same canvas as the workflow editor) and saves
   via the daemon template API.
   ══════════════════════════════════════════ */

export default function TemplateSettings() {
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

  // 画布改动（FlowCanvas）与元信息改动（名称/描述/标识）任一存在即为未保存
  const editorDirty = canvasDirty || metaDirty

  const refresh = useCallback(async (force = false) => {
    try {
      const { templates: list } = await fetchTemplates(force)
      setTemplates(list)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取流程模板失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const openEditor = async (t: TemplateInfo) => {
    setError('')
    try {
      const full = await templateApi.get(t.id)
      setEditing({ ...full, custom: Boolean(t.custom) })
      setMeta({
        id: full.id || '',
        name: full.name || '',
        description: full.description || '',
      })
      setCanvasDirty(false)
      setMetaDirty(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载模板失败')
    }
  }

  const closeEditor = () => {
    setEditing(null)
    setCanvasDirty(false)
    setMetaDirty(false)
  }

  const metaError = (() => {
    if (!editing) return ''
    const id = meta.id.trim()
    if (!id) return ''
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      return '模板标识需以字母或数字开头，只能包含字母、数字、下划线或连字符（最长 64 位）'
    }
    if (templates.some((t) => t.id === id && t.id !== editing.id)) {
      return `模板标识 “${id}” 已存在`
    }
    return ''
  })()

  const saveTemplate = async (steps: any) => {
    const id = meta.id.trim()
    const name = meta.name.trim()
    if (!id) throw new Error('模板标识不能为空')
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      throw new Error('模板标识需以字母或数字开头，只能包含字母、数字、下划线或连字符（最长 64 位）')
    }
    if (!name) throw new Error('模板名称不能为空')
    if (id !== editing?.id && templates.some((t) => t.id === id)) {
      throw new Error(`模板标识 “${id}” 已存在`)
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
    if (!id) { setCreateError('请输入模板标识'); return }
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      setCreateError('标识需以字母或数字开头，只能包含字母、数字、下划线或连字符（最长 64 位）')
      return
    }
    if (templates.some((t) => t.id === id)) {
      setCreateError(`模板标识 “${id}” 已存在`)
      return
    }
    if (!name) { setCreateError('请输入模板名称'); return }
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
      setCreateError(reason instanceof Error ? reason.message : '创建失败')
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
      setError(reason instanceof Error ? reason.message : '删除模板失败')
      setDeleting(null)
    } finally {
      setDeletingBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>流程模板</h1>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            流程模板统一存放在 <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>~/.workstep/data/templates/</code> 
            默认模板（<code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>default: true</code>）不可删除，自建模板可删除。
          </p>
        </div>
        <Button variant="primary" onClick={() => { setCreateOpen(true); setCreateError('') }}>
          + 新建模板
        </Button>
      </div>

      {error && (
        <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--danger)' }}>{error}</div>
      )}

      {loading ? (
        <div style={{ padding: '18px 4px', fontSize: 13, color: 'var(--meta)' }}>正在读取模板…</div>
      ) : templates.length === 0 ? (
        <div style={{ padding: '18px 4px', fontSize: 13, color: 'var(--meta)' }}>暂无模板</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map((t) => (
            <div
              key={t.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</span>
                  <span style={{
                    fontSize: 11, padding: '1px 7px', borderRadius: 99, flexShrink: 0,
                    background: t.custom
                      ? (t.default
                        ? 'color-mix(in oklab, var(--success), transparent 90%)'
                        : 'color-mix(in oklab, var(--accent), transparent 88%)')
                      : 'var(--surface)',
                    color: t.custom ? (t.default ? 'var(--success)' : 'var(--accent)') : 'var(--muted)',
                    border: '1px solid var(--border-soft)',
                  }}>
                    {t.custom ? (t.default ? '默认' : '自定义') : '内置'}
                  </span>
                </div>
                {t.description && (
                  <div style={{ fontSize: 13, color: 'var(--meta)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.description}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--meta)', flexShrink: 0 }}>{t.nodeCount} 步</span>
              <Button variant="ghost" style={{ height: 28, padding: '0 10px', fontSize: 13 }} onClick={() => void openEditor(t)}>
                编辑
              </Button>
              {t.custom && !t.default && (
                <Button variant="ghost" style={{ height: 28, padding: '0 10px', fontSize: 13, color: 'var(--danger)' }} onClick={() => setDeleting(t)}>
                  删除
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
              <span className="modal-title">新建流程模板</span>
              <Button variant="icon" aria-label="关闭" onClick={() => setCreateOpen(false)}>✕</Button>
            </div>
            <div className="modal-body">
              <Field label="标识（id）" htmlFor="tpl-id" error={createError}>
              <Input
                id="tpl-id"
                value={newDraft.id}
                onChange={(e) => { setNewDraft({ ...newDraft, id: e.target.value }); setCreateError('') }}
                placeholder="例如：my-flow"
                autoFocus
              />
              </Field>
              <Field label="名称" htmlFor="tpl-name">
              <Input
                id="tpl-name"
                value={newDraft.name}
                onChange={(e) => { setNewDraft({ ...newDraft, name: e.target.value }); setCreateError('') }}
                placeholder="例如：我的研发流程"
              />
              </Field>
              <Field label="描述" htmlFor="tpl-desc">
              <Input
                id="tpl-desc"
                value={newDraft.description}
                onChange={(e) => { setNewDraft({ ...newDraft, description: e.target.value }); setCreateError('') }}
                placeholder="简短描述该模板的用途"
              />
              </Field>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
              <Button variant="primary" disabled={creating} loading={creating} onClick={() => void createTemplate()}>
                创建并编辑
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
              aria-label="返回模板列表"
              title="返回模板列表"
              onClick={() => { if (editorDirty) { setConfirmClose(true); return } closeEditor() }}
              style={{ height: 30, padding: '0 9px' }}
            >
              ← 返回
            </Button>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
              模板元信息
            </span>
            {editing.default ? (
              <span style={{ fontSize: 11, color: 'var(--meta)' }}>默认模板：保存将写回 ~/.workstep/data/templates/ 对应文件</span>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--meta)' }}>自定义模板：保存将写回 ~/.workstep/data/templates/ 对应文件</span>
            )}
            <div style={{ flex: 1 }} />
            <Input
              value={meta.id}
              onChange={(e) => { setMeta({ ...meta, id: e.target.value }); setMetaDirty(true) }}
              placeholder="标识（英数_-，≤64）"
              title="模板标识"
              spellCheck={false}
              style={{ width: 150, height: 28 }}
            />
            <Input
              value={meta.name}
              onChange={(e) => { setMeta({ ...meta, name: e.target.value }); setMetaDirty(true) }}
              placeholder="模板名称"
              title="模板名称"
              style={{ width: 170, height: 28 }}
            />
            <Input
              value={meta.description}
              onChange={(e) => { setMeta({ ...meta, description: e.target.value }); setMetaDirty(true) }}
              placeholder="模板描述（可选）"
              title="模板描述"
              style={{ width: 220, height: 28 }}
            />
            {metaDirty && <span style={{ color: 'var(--warn-text)', fontSize: 11, whiteSpace: 'nowrap' }}>⚠ 元信息未保存</span>}
          </div>
          {metaError && (
            <div style={{
              padding: '6px 14px', fontSize: 13, color: 'var(--danger)', flexShrink: 0,
              background: 'color-mix(in oklab, var(--danger), transparent 92%)',
              borderBottom: '1px solid var(--border-soft)',
            }}>
              {metaError}
            </div>
          )}
          <FlowCanvas
            initialSteps={editing.steps || { nodes: [], connections: [] }}
            onSave={saveTemplate}
            onDirtyChange={setCanvasDirty}
            showTemplatePicker={false}
            title="流程模板编辑器"
            saveLabel="保存模板"
            hint={null}
          />
        </div>,
        document.body,
      )}

      {/* Unsaved changes confirm */}
      <ConfirmDialog
        open={confirmClose}
        title="未保存的更改"
        message="有未保存的更改，确定放弃并返回模板列表？"
        confirmText="放弃更改"
        danger
        onConfirm={() => { setConfirmClose(false); closeEditor() }}
        onCancel={() => setConfirmClose(false)}
      />

      {/* Delete template confirm */}
      <ConfirmDialog
        open={deleting !== null}
        title="删除模板"
        message={deleting ? `确定删除模板「${deleting.name}」？此操作不可恢复。` : undefined}
        confirmText="删除"
        danger
        onConfirm={() => void deleteTemplate()}
        onCancel={() => { if (!deletingBusy) setDeleting(null) }}
      />
    </div>
  )
}
