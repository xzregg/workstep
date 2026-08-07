import Icon from './Icon'
import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useTaskStore } from '../stores/taskStore'
import { useWebSocket } from '../hooks/useWebSocket'
import Button from './Button'
import DirectoryBrowser from './DirectoryBrowser'
import Field from './Field'
import Input from './Input'
import SettingsPage from '../pages/SettingsPage'
import Select from './Select'
import ConfirmDialog from './ConfirmDialog'
import AiFlowChat from './AiFlowChat'
import FlowCanvas, { type FlowCanvasHandle } from './FlowCanvas'
import {
  fetchTemplates,
  templateApi,
  type TemplateInfo,
  type Project,
} from '../api/client'

const sidebarStyle: React.CSSProperties = {
  width: 280, minWidth: 280,
  background: 'var(--bg)',
  borderRight: '1px solid var(--border-soft)',
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
}

const sectionLabel: React.CSSProperties = {
  padding: '14px 14px 6px',
  fontSize: 11, fontWeight: 600,
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  display: 'flex', alignItems: 'center',
  justifyContent: 'space-between',
}

const projectItemStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '9px 12px', borderRadius: 10,
  cursor: 'pointer', fontSize: 13,
  color: active ? 'var(--fg)' : 'var(--fg-2)',
  background: active ? 'var(--surface)' : 'transparent',
  fontWeight: active ? 500 : 400,
  marginBottom: 2,
  transition: 'all var(--motion-fast)',
})

const addButtonStyle: React.CSSProperties = {
  margin: '8px 12px 8px',
  padding: 8,
  border: '1.5px dashed var(--border)',
  borderRadius: 'var(--radius-sm)',
  textAlign: 'center' as const,
  cursor: 'pointer', color: 'var(--meta)',
  fontSize: 13, background: 'transparent',
  width: 'calc(100% - 24px)',
  fontFamily: 'var(--font-body)',
}

const hasWhitespace = (s: string) => /\s/.test(s)

interface Props {
  onSelectProject: (p: Project) => void
  children: React.ReactNode
}

export default function Layout({ onSelectProject, children }: Props) {
  useWebSocket()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { projects, activeProject, activeWorkflowId, fetchProjects, initProject, setActiveProject, renameProject, renameWorkflow, createWorkflow, deleteWorkflow, restoreWorkflow, setActiveWorkflow } = useProjectStore()
  const [showInitModal, setShowInitModal] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [showBrowser, setShowBrowser] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [addWfProjectId, setAddWfProjectId] = useState<string | null>(null)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [addWfTemplateId, setAddWfTemplateId] = useState('')
  const [addWfSteps, setAddWfSteps] = useState<any>(null)
  const [addWfPreviewDirty, setAddWfPreviewDirty] = useState(false)
  const [addWfGenBusy, setAddWfGenBusy] = useState(false)
  const [addWfCreating, setAddWfCreating] = useState(false)
  const [addWfError, setAddWfError] = useState('')
  const [addWfNameAttempted, setAddWfNameAttempted] = useState(false)
  const [addWfConfirmClose, setAddWfConfirmClose] = useState(false)
  const [pendingAiSteps, setPendingAiSteps] = useState<any>(null)
  const [addWfSize, setAddWfSize] = useState<{ width: number; height: number } | null>(null)
  const [addWfChatWidth, setAddWfChatWidth] = useState(380)
  const [renameWfId, setRenameWfId] = useState<string | null>(null)
  const [renameWfName, setRenameWfName] = useState('')
  const [newWfName, setNewWfName] = useState('')
  const [deleteWf, setDeleteWf] = useState<{ id: string; projectId: string; name: string; soft: boolean } | null>(null)
  const [pendingWfSwitch, setPendingWfSwitch] = useState<{ project: Project; workflowId: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const wfInputRef = useRef<HTMLInputElement>(null)
  const renameWfInputRef = useRef<HTMLInputElement>(null)
  const previewCanvasRef = useRef<FlowCanvasHandle>(null)
  const addWfModalRef = useRef<HTMLDivElement>(null)

  const startDividerDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = addWfChatWidth
    const onMove = (ev: MouseEvent) => {
      setAddWfChatWidth(Math.min(560, Math.max(280, startWidth - (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }

  const startModalResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const rect = addWfModalRef.current?.getBoundingClientRect()
    const startWidth = rect?.width ?? 1160
    const startHeight = rect?.height ?? 780
    const onMove = (ev: MouseEvent) => {
      const width = Math.min(window.innerWidth - 24, Math.max(760, startWidth + (ev.clientX - startX)))
      const height = Math.min(window.innerHeight - 24, Math.max(480, startHeight + (ev.clientY - startY)))
      setAddWfSize({ width, height })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'nwse-resize'
  }

  useEffect(() => { fetchProjects() }, [fetchProjects])

  // Re-focus inputs each time they open (autoFocus only fires on first mount)
  useEffect(() => {
    if (renameId) {
      const t = setTimeout(() => renameInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [renameId])

  useEffect(() => {
    if (addWfProjectId) {
      const t = setTimeout(() => wfInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [addWfProjectId])

  useEffect(() => {
    if (renameWfId) {
      const t = setTimeout(() => renameWfInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [renameWfId])

  // Refresh flow running states whenever a task status event arrives
  const taskStatusEvents = useTaskStore((s) => s.taskStatusEvents)
  useEffect(() => {
    if (!taskStatusEvents) return
    const t = setTimeout(() => { fetchProjects() }, 300)
    return () => clearTimeout(t)
  }, [taskStatusEvents, fetchProjects])

  // Auto-select project from URL ?project=name (only once)
  const projectName = searchParams.get('project')
  useEffect(() => {
    if (projectName && projects.length > 0 && (!activeProject || activeProject.name !== projectName)) {
      const match = projects.find((p) => p.name === projectName)
      if (match) {
        setActiveProject(match)
      }
    }
  }, [projectName, projects, activeProject, setActiveProject])

  const handleSelectProject = (p: Project) => {
    setActiveProject(p)
    onSelectProject(p)
  }

  const openAddWorkflow = async (projectId: string) => {
    setAddWfProjectId(projectId)
    setNewWfName('')
    setAddWfTemplateId('')
    setAddWfSteps(null)
    setAddWfPreviewDirty(false)
    setAddWfGenBusy(false)
    setAddWfError('')
    setAddWfNameAttempted(false)
    setAddWfConfirmClose(false)
    setPendingAiSteps(null)
    setAddWfSize(null)
    setAddWfChatWidth(380)
    try {
      const { templates: list } = await fetchTemplates()
      setTemplates(list)
    } catch {
      setTemplates([])
    }
  }

  const closeAddWorkflow = () => {
    setAddWfProjectId(null)
    setNewWfName('')
    setAddWfTemplateId('')
    setAddWfSteps(null)
    setAddWfPreviewDirty(false)
    setAddWfGenBusy(false)
    setAddWfError('')
    setAddWfNameAttempted(false)
    setAddWfConfirmClose(false)
    setPendingAiSteps(null)
    setAddWfSize(null)
    setAddWfChatWidth(380)
  }

  const requestCloseAddWorkflow = () => {
    if (addWfPreviewDirty || addWfGenBusy) {
      setAddWfConfirmClose(true)
      return
    }
    closeAddWorkflow()
  }

  const handleAiProposal = (steps: any) => {
    // A new proposal replaces the preview; guard manual edits with a confirm.
    if (addWfPreviewDirty) {
      setPendingAiSteps(steps)
      return
    }
    setAddWfSteps(steps)
  }

  const handleTemplateChange = async (templateId: string) => {
    setAddWfTemplateId(templateId)
    setAddWfError('')
    if (!templateId) {
      setAddWfSteps(null)
      return
    }
    try {
      const full = await templateApi.get(templateId)
      setAddWfSteps(full.steps || { nodes: [], connections: [] })
    } catch (reason) {
      setAddWfError(reason instanceof Error ? reason.message : '加载模板失败')
    }
  }

  const handleAddWorkflow = async () => {
    if (!addWfProjectId || addWfGenBusy) return
    if (!newWfName.trim()) {
      setAddWfNameAttempted(true)
      wfInputRef.current?.focus()
      return
    }
    if (hasWhitespace(newWfName)) {
      setAddWfNameAttempted(true)
      wfInputRef.current?.focus()
      return
    }
    const validationError = previewCanvasRef.current?.validate() ?? null
    if (validationError) {
      setAddWfError(validationError)
      return
    }
    const steps = previewCanvasRef.current?.getSteps() ?? addWfSteps ?? undefined
    setAddWfCreating(true)
    setAddWfError('')
    try {
      await createWorkflow(addWfProjectId, newWfName.trim(), addWfTemplateId || undefined, steps)
      closeAddWorkflow()
    } catch (reason) {
      setAddWfError(reason instanceof Error ? reason.message : '创建流程失败')
    } finally {
      setAddWfCreating(false)
    }
  }

  const handleInit = async () => {
    if (!newPath.trim()) return
    if (hasWhitespace(newName)) {
      setError('项目名称不能包含空白字符（空格、Tab 等）')
      return
    }
    try {
      setError('')
      const proj = await initProject(newPath.trim(), newName.trim() || undefined)
      setActiveProject(proj)
      onSelectProject(proj)
      setShowInitModal(false)
      setNewPath('')
      setNewName('')
      setShowBrowser(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleDirSelect = (path: string) => {
    setNewPath(path)
    setShowBrowser(false)
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <aside style={sidebarStyle}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-display)' }}>
            <Icon name="layers" size={18} strokeWidth={2} color="var(--accent)" />
            WorkStep
          </div>
        </div>

        <div style={sectionLabel}>项目</div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
          {projects.map((p) => (
            <div key={p.path}>
              <div
                onClick={() => handleSelectProject(p)}
                onDoubleClick={(e) => { e.stopPropagation(); setRenameId(p.path); setRenameName(p.name); setRenameError('') }}
                style={{ ...projectItemStyle(activeProject?.path === p.path), position: 'relative' }}
              >
                <Icon
                  name="chevron-right" size={12}
                  style={{
                    flexShrink: 0,
                    transition: 'transform var(--motion-fast)',
                    transform: activeProject?.path === p.path ? 'rotate(90deg)' : 'none',
                    opacity: activeProject?.path === p.path ? 1 : 0.55,
                  }}
                />
                <Icon name="folder" size={16} strokeWidth={2} />
                {renameId === p.path ? (
                  <Input
                    ref={renameInputRef}
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' && renameName.trim()) {
                        if (hasWhitespace(renameName)) {
                          setRenameError('名称不能包含空白字符（空格、Tab 等）')
                          return
                        }
                        await renameProject(p.path, renameName.trim())
                        setRenameId(null)
                      }
                      if (e.key === 'Escape') { setRenameId(null); setRenameError('') }
                    }}
                    onBlur={async () => {
                      if (renameName.trim() && renameName !== p.name) {
                        if (hasWhitespace(renameName)) {
                          setRenameError('名称不能包含空白字符（空格、Tab 等）')
                          setRenameId(null)
                          return
                        }
                        await renameProject(p.path, renameName.trim())
                      }
                      setRenameId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ flex: 1, height: 22, fontSize: 13, padding: '0 4px', border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                  />
                ) : (
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); openAddWorkflow(p.id) }}
                  title="添加工作流"
                  style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--meta)', fontSize: 13, lineHeight: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, opacity: 0.7 }}
                >+</button>
              </div>

              {renameId === p.path && renameError && (
                <div style={{ marginLeft: 38, marginBottom: 4, fontSize: 11, color: 'var(--danger)' }}>{renameError}</div>
              )}

              {/* Workflow list under the selected project */}
              {activeProject?.path === p.path && (p.workflows || []).map(wf => (
                (() => {
                  const deleted = !!wf.deleted
                  const activeCount = (p.workflows || []).filter(w => !w.deleted).length
                  return (
                    <div
                      key={wf.id}
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (deleted) return
                        const dirty = useProjectStore.getState().canvasDirty
                        if (location.pathname === '/canvas' && dirty) {
                          setPendingWfSwitch({ project: p, workflowId: wf.id })
                          return
                        }
                        setActiveProject(p)
                        if (location.pathname === '/canvas') {
                          navigate(`/canvas?project=${encodeURIComponent(p.name)}&workflow=${encodeURIComponent(wf.id)}`)
                        } else {
                          await setActiveWorkflow(wf.id)
                        }
                      }}
                      style={{
                        marginLeft: 28, padding: '4px 10px', borderRadius: 6,
                        cursor: deleted ? 'default' : 'pointer',
                        fontSize: 13,
                        color: deleted ? 'var(--meta)' : (activeProject?.path === p.path && activeWorkflowId === wf.id ? 'var(--accent)' : 'var(--meta)'),
                        background: activeProject?.path === p.path && activeWorkflowId === wf.id ? 'var(--accent-light, #e6f0ff)' : 'transparent',
                        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1,
                      }}
                    >
                      <Icon name="external-link" size={12} strokeWidth={2} />
                      {renameWfId === wf.id ? (
                        <Input
                          ref={renameWfInputRef}
                          value={renameWfName}
                          onChange={(e) => setRenameWfName(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && renameWfName.trim() && !hasWhitespace(renameWfName)) {
                              try { await renameWorkflow(wf.id, p.id, renameWfName.trim()) } catch {}
                              setRenameWfId(null)
                            }
                            if (e.key === 'Escape') setRenameWfId(null)
                          }}
                          onBlur={async () => {
                            if (renameWfName.trim() && renameWfName !== wf.name && !hasWhitespace(renameWfName)) {
                              try { await renameWorkflow(wf.id, p.id, renameWfName.trim()) } catch {}
                            }
                            setRenameWfId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{ flex: 1, height: 20, fontSize: 13, padding: '0 4px', border: `1px solid ${hasWhitespace(renameWfName) ? 'var(--danger)' : 'var(--accent)'}`, borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                        />
                      ) : (
                        <span
                          style={{ flex: 1, textDecoration: deleted ? 'line-through' : 'none', opacity: deleted ? 0.6 : 1, cursor: deleted ? 'default' : 'pointer' }}
                          onDoubleClick={(e) => { e.stopPropagation(); if (!deleted) { setRenameWfId(wf.id); setRenameWfName(wf.name) } }}
                        >{wf.name}</span>
                      )}
                      {wf.running && !deleted && (
                        <span className="task-status-spinner" style={{ color: 'var(--accent)', flexShrink: 0 }} title="流程执行中" aria-hidden="true" />
                      )}
                      {deleted && <span style={{ fontSize: 11, color: 'var(--danger)', opacity: 0.8 }}>回收站</span>}
                      {wf.is_default ? <span style={{ fontSize: 11, opacity: 0.6 }}>默认</span> : null}
                      <span style={{ fontSize: 11, opacity: 0.5 }}>{wf.nodeCount}步</span>
                      {deleted && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            restoreWorkflow(wf.id, p.id)
                          }}
                          title="恢复流程"
                          style={{ width: 14, height: 14, border: 'none', background: 'transparent', color: 'var(--status-done)', cursor: 'pointer', fontSize: 13, lineHeight: '14px', padding: 0 }}
                        >↩</button>
                      )}
                      {!wf.is_default && (deleted || activeCount > 1) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteWf({ id: wf.id, projectId: p.id, name: wf.name, soft: deleted })
                          }}
                          title={deleted ? '永久删除' : '删除（移入回收站）'}
                          style={{ width: 14, height: 14, border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', fontSize: 11, lineHeight: '14px', padding: 0 }}
                        >×</button>
                      )}
                    </div>
                  )
                })()
              ))}
            </div>
          ))}
          {projects.length === 0 && (
            <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--meta)', fontStyle: 'italic' }}>
              还没有项目
            </div>
          )}
        </div>

        <button style={addButtonStyle} onClick={() => setShowInitModal(true)}>
          + 添加项目
        </button>
        <button
          onClick={() => setShowSettings(true)}
          aria-current={showSettings ? 'page' : undefined}
          style={{
            margin: '0 12px 12px', width: 'calc(100% - 24px)', height: 36,
            padding: '0 10px', justifyContent: 'flex-start', gap: 9,
            borderRadius: 9, fontSize: 13,
            color: showSettings ? 'var(--fg)' : 'var(--fg-2)',
            background: showSettings ? 'var(--surface)' : 'transparent',
          }}
        >
          <Icon name="settings" size={17} strokeWidth={2} />
          设置
        </button>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {children}
      </main>

      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} />}

      {/* Init project modal */}
      {showInitModal && (
        <div className="modal-overlay" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>
          <div className="modal" style={{ width: showBrowser ? 600 : 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">初始化项目</span>
              <Button variant="icon" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>✕</Button>
            </div>
            <div className="modal-body">
              <Field label="项目路径" htmlFor="init-path">
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input
                    id="init-path"
                    style={{ flex: 1 }}
                    placeholder="/Users/me/my-app"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                  />
                  <Button variant="ghost" onClick={() => setShowBrowser(!showBrowser)}>
                    {showBrowser ? '收起' : '浏览'}
                  </Button>
                </div>
              </Field>

              {showBrowser && (
                <div style={{ marginTop: 8 }}>
                  <DirectoryBrowser onSelect={handleDirSelect} />
                </div>
              )}

              <Field label="项目名称（可选）" htmlFor="init-name" error={error}>
                <Input
                  id="init-name"
                  placeholder="默认使用目录名"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleInit()}
                />
              </Field>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>取消</Button>
              <Button variant="primary" onClick={handleInit}>初始化</Button>
            </div>
          </div>
        </div>
      )}

      {/* Add workflow modal */}
      {addWfProjectId && (
        <div className="modal-overlay" onClick={requestCloseAddWorkflow} style={{ zIndex: 350 }}>
          <div
            ref={addWfModalRef}
            className="modal"
            style={{
              width: addWfSize ? addWfSize.width : 1160, maxWidth: '96vw',
              height: addWfSize ? addWfSize.height : 'min(92vh, 900px)', maxHeight: '92vh',
              display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title">添加流程（AI 生成 / 模板）</span>
              <Button variant="icon" aria-label="关闭" onClick={requestCloseAddWorkflow}>✕</Button>
            </div>
            {/* Top form: workflow name + template */}
            <div style={{
              flexShrink: 0, padding: '12px 18px', background: 'var(--bg)',
              borderBottom: '1px solid var(--border-soft)',
              display: 'flex', gap: 14, alignItems: 'flex-start',
            }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Field
                  label="流程名称"
                  required
                  htmlFor="wf-name"
                  error={hasWhitespace(newWfName)
                    ? '名称不能包含空白字符（空格、Tab 等）'
                    : addWfNameAttempted && !newWfName.trim()
                      ? '流程名称为必填项，请输入流程名称'
                      : undefined}
                >
                  <Input
                    id="wf-name"
                    ref={wfInputRef}
                    value={newWfName}
                    onChange={(e) => setNewWfName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddWorkflow()}
                    placeholder="流程名称（必填，不能包含空格）"
                    autoFocus
                    style={{ border: `1px solid ${(hasWhitespace(newWfName) || (addWfNameAttempted && !newWfName.trim())) ? 'var(--danger)' : 'var(--border)'}` }}
                  />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <Field label="流程模板" htmlFor="wf-template">
                  <Select
                    id="wf-template"
                    value={addWfTemplateId}
                    onChange={(e) => void handleTemplateChange(e.target.value)}
                    style={{ width: '100%' }}
                  >
                  <option value="">空白流程</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}（{t.nodeCount}步）</option>
                  ))}
                  </Select>
                </Field>
                {(() => {
                  const selected = templates.find((t) => t.id === addWfTemplateId)
                  return selected?.description ? (
                    <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.description}</p>
                  ) : (
                    <p style={{ fontSize: 13, color: 'var(--meta)', marginTop: 4 }}>也可在右侧让 AI 根据目标生成流程</p>
                  )
                })()}
              </div>
            </div>
            {addWfError && (
              <div style={{
                flexShrink: 0, padding: '5px 18px', fontSize: 13, color: 'var(--danger)',
                background: 'color-mix(in oklab, var(--danger), transparent 94%)',
                borderBottom: '1px solid var(--border-soft)',
              }}>{addWfError}</div>
            )}
            <div className="modal-body" style={{ padding: 0, display: 'flex', minHeight: 0, flex: 1, overflow: 'hidden' }}>
              {/* Left: live editable canvas preview */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <FlowCanvas
                  ref={previewCanvasRef}
                  initialSteps={addWfSteps}
                  projectId={addWfProjectId}
                  onDirtyChange={setAddWfPreviewDirty}
                  onSave={async (steps) => { setAddWfSteps(steps); setAddWfPreviewDirty(false) }}
                  showTemplatePicker={false}
                  title="流程预览"
                  saveLabel="更新预览"
                  hint={null}
                />
              </div>
              {/* Draggable divider to resize the chat column */}
              <div
                onMouseDown={startDividerDrag}
                title="拖动调整聊天区宽度"
                style={{
                  width: 8, flexShrink: 0, cursor: 'col-resize', position: 'relative',
                  background: 'transparent', userSelect: 'none',
                }}
              >
                <div style={{
                  position: 'absolute', top: 0, bottom: 0, left: '50%', transform: 'translateX(-50%)',
                  width: 1, background: 'var(--border-soft)',
                }} />
              </div>
              {/* Right: AI flow-design chat */}
              <div style={{
                width: addWfChatWidth, flexShrink: 0,
                display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)',
              }}>
                <AiFlowChat
                  projectId={addWfProjectId}
                  onProposal={handleAiProposal}
                  onBusyChange={setAddWfGenBusy}
                  title="AI 流程助手"
                />
              </div>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={requestCloseAddWorkflow}>取消</Button>
              <Button
                variant="primary"
                disabled={addWfGenBusy || addWfCreating}
                loading={addWfCreating}
                onClick={handleAddWorkflow}
              >创建流程</Button>
            </div>
            {/* Bottom-right corner resize handle */}
            <div
              onMouseDown={startModalResize}
              title="拖动调整弹框大小"
              style={{
                position: 'absolute', right: 0, bottom: 0, width: 20, height: 20,
                cursor: 'nwse-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
                padding: 3, color: 'var(--meta)', userSelect: 'none', zIndex: 5,
              }}
            >
              <Icon name="resize-corner" size={11} />
            </div>
          </div>
        </div>
      )}

      {/* Add workflow: confirm close with unsaved preview / running generation */}
      <ConfirmDialog
        open={addWfConfirmClose}
        title="未保存的更改"
        message={addWfGenBusy
          ? 'AI 正在生成流程，确定放弃并关闭？'
          : '流程预览有未保存的改动，确定放弃并关闭？'}
        confirmText="放弃更改"
        danger
        onConfirm={closeAddWorkflow}
        onCancel={() => setAddWfConfirmClose(false)}
      />

      {/* Add workflow: AI proposal overwrites manual preview edits */}
      <ConfirmDialog
        open={pendingAiSteps !== null}
        title="AI 提案将覆盖预览"
        message="新生成的流程提案将替换当前预览中的手动改动。确定应用？"
        confirmText="应用提案"
        danger
        onConfirm={() => {
          if (pendingAiSteps !== null) setAddWfSteps(pendingAiSteps)
          setPendingAiSteps(null)
        }}
        onCancel={() => setPendingAiSteps(null)}
      />

      {/* Delete workflow confirm */}
      <ConfirmDialog
        open={!!deleteWf}
        title={deleteWf?.soft ? '永久删除流程' : '删除流程'}
        message={deleteWf
          ? (deleteWf.soft
            ? `确定永久删除流程「${deleteWf.name}」？将同时清除该项目数据库中该流程的全部数据（任务、消息、执行记录、审核记录等所有相关表），此操作不可恢复。`
            : `确定删除流程「${deleteWf.name}」？流程将移入回收站（以删除线显示），可随时恢复；再次点击删除将永久清除该流程的全部数据。`)
          : undefined}
        confirmText={deleteWf?.soft ? '永久删除' : '删除'}
        danger
        onConfirm={() => {
          if (deleteWf) deleteWorkflow(deleteWf.id, deleteWf.projectId)
          setDeleteWf(null)
        }}
        onCancel={() => setDeleteWf(null)}
      />

      {/* Unsaved canvas changes → switch workflow */}
      <ConfirmDialog
        open={!!pendingWfSwitch}
        title="未保存的更改"
        message="有未保存的更改，确定切换工作流？"
        confirmText="切换"
        onConfirm={() => {
          if (pendingWfSwitch) {
            const { project, workflowId } = pendingWfSwitch
            setActiveProject(project)
            navigate(`/canvas?project=${encodeURIComponent(project.name)}&workflow=${encodeURIComponent(workflowId)}`)
          }
          setPendingWfSwitch(null)
        }}
        onCancel={() => setPendingWfSwitch(null)}
      />
    </div>
  )
}
