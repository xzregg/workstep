import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useWebSocket } from '../hooks/useWebSocket'
import DirectoryBrowser from './DirectoryBrowser'
import SettingsPage from '../pages/SettingsPage'
import ConfirmDialog from './ConfirmDialog'
import type { Project } from '../api/client'

const sidebarStyle: React.CSSProperties = {
  width: 280, minWidth: 280,
  background: 'var(--bg)',
  borderRight: '1px solid var(--border-soft)',
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
}

const sectionLabel: React.CSSProperties = {
  padding: '14px 14px 6px',
  fontSize: 12, fontWeight: 600,
  color: 'var(--meta)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.3px',
  display: 'flex', alignItems: 'center',
  justifyContent: 'space-between',
}

const projectItemStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '9px 12px', borderRadius: 10,
  cursor: 'pointer', fontSize: 14,
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
  fontSize: 12, background: 'transparent',
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
  const { projects, activeProject, activeWorkflowId, fetchProjects, initProject, setActiveProject, renameProject, renameWorkflow, createWorkflow, deleteWorkflow, setActiveWorkflow } = useProjectStore()
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
  const [renameWfId, setRenameWfId] = useState<string | null>(null)
  const [renameWfName, setRenameWfName] = useState('')
  const [newWfName, setNewWfName] = useState('')
  const [deleteWf, setDeleteWf] = useState<{ id: string; projectId: string; name: string; soft: boolean } | null>(null)
  const [pendingWfSwitch, setPendingWfSwitch] = useState<{ project: Project; workflowId: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const wfInputRef = useRef<HTMLInputElement>(null)
  const renameWfInputRef = useRef<HTMLInputElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontWeight: 600, fontSize: 14, fontFamily: 'var(--font-display)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
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
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{
                    flexShrink: 0,
                    transition: 'transform var(--motion-fast)',
                    transform: activeProject?.path === p.path ? 'rotate(90deg)' : 'none',
                    opacity: activeProject?.path === p.path ? 1 : 0.55,
                  }}
                >
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                {renameId === p.path ? (
                  <input
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
                  onClick={(e) => { e.stopPropagation(); setAddWfProjectId(p.id); setNewWfName('') }}
                  title="添加工作流"
                  style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--meta)', fontSize: 14, lineHeight: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, opacity: 0.7 }}
                >+</button>
              </div>

              {renameId === p.path && renameError && (
                <div style={{ marginLeft: 38, marginBottom: 4, fontSize: 11, color: 'var(--danger)' }}>{renameError}</div>
              )}

              {/* Inline workflow creation */}
              {addWfProjectId === p.id && (
                <div style={{ marginLeft: 28, marginBottom: 4 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      ref={wfInputRef}
                      value={newWfName}
                      onChange={(e) => setNewWfName(e.target.value)}
                      placeholder="工作流名称"
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && newWfName.trim() && !hasWhitespace(newWfName)) {
                          try {
                            await createWorkflow(p.id, newWfName.trim())
                          } finally {
                            setAddWfProjectId(null)
                          }
                        }
                        if (e.key === 'Escape') setAddWfProjectId(null)
                      }}
                      onBlur={() => {
                        blurTimerRef.current = setTimeout(() => setAddWfProjectId(null), 150)
                      }}
                      style={{ flex: 1, height: 24, fontSize: 12, padding: '0 6px', border: `1px solid ${hasWhitespace(newWfName) ? 'var(--danger)' : 'var(--accent)'}`, borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                    />
                    <button
                      disabled={!newWfName.trim() || hasWhitespace(newWfName)}
                      onMouseDown={() => clearTimeout(blurTimerRef.current)}
                      onClick={async () => {
                        if (newWfName.trim() && !hasWhitespace(newWfName)) {
                          try {
                            await createWorkflow(p.id, newWfName.trim())
                          } finally {
                            setAddWfProjectId(null)
                          }
                        }
                      }}
                      style={{ height: 24, fontSize: 11, padding: '0 8px', border: 'none', borderRadius: 4, background: 'var(--accent)', color: '#fff', cursor: 'pointer', opacity: !newWfName.trim() || hasWhitespace(newWfName) ? 0.5 : 1 }}
                    >创建</button>
                  </div>
                  {hasWhitespace(newWfName) && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>名称不能包含空白字符（空格、Tab 等）</div>
                  )}
                </div>
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
                        fontSize: 12,
                        color: deleted ? 'var(--meta)' : (activeProject?.path === p.path && activeWorkflowId === wf.id ? 'var(--accent)' : 'var(--meta)'),
                        background: activeProject?.path === p.path && activeWorkflowId === wf.id ? 'var(--accent-light, #e6f0ff)' : 'transparent',
                        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                      </svg>
                      {renameWfId === wf.id ? (
                        <input
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
                          style={{ flex: 1, height: 20, fontSize: 12, padding: '0 4px', border: `1px solid ${hasWhitespace(renameWfName) ? 'var(--danger)' : 'var(--accent)'}`, borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                        />
                      ) : (
                        <span
                          style={{ flex: 1, textDecoration: deleted ? 'line-through' : 'none', opacity: deleted ? 0.6 : 1, cursor: deleted ? 'default' : 'pointer' }}
                          onDoubleClick={(e) => { e.stopPropagation(); if (!deleted) { setRenameWfId(wf.id); setRenameWfName(wf.name) } }}
                        >{wf.name}</span>
                      )}
                      {deleted && <span style={{ fontSize: 10, color: 'var(--danger)', opacity: 0.8 }}>回收站</span>}
                      {wf.is_default ? <span style={{ fontSize: 10, opacity: 0.6 }}>默认</span> : null}
                      <span style={{ fontSize: 10, opacity: 0.5 }}>{wf.nodeCount}步</span>
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
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.66.96.3.26.68.4 1.08.4H21a2 2 0 1 1 0 4h-.09c-.4 0-.78.14-1.08.4-.3.26-.52.59-.66.96z"/>
          </svg>
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
              <button className="btn-icon" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>✕</button>
            </div>
            <div className="modal-body">
              <label>项目路径</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ flex: 1 }}
                  placeholder="/Users/me/my-app"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                />
                <button className="btn-ghost" onClick={() => setShowBrowser(!showBrowser)}>
                  {showBrowser ? '收起' : '浏览'}
                </button>
              </div>

              {showBrowser && (
                <div style={{ marginTop: 8 }}>
                  <DirectoryBrowser onSelect={handleDirSelect} />
                </div>
              )}

              <label>项目名称（可选）</label>
              <input
                placeholder="默认使用目录名"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleInit()}
              />
              {error && <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{error}</p>}
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>取消</button>
              <button className="btn-primary" onClick={handleInit}>初始化</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete workflow confirm */}
      <ConfirmDialog
        open={!!deleteWf}
        title={deleteWf?.soft ? '永久删除流程' : '删除流程'}
        message={deleteWf
          ? (deleteWf.soft
            ? `确定永久删除流程「${deleteWf.name}」？此操作不可恢复。`
            : `确定删除流程「${deleteWf.name}」？流程将移入回收站（以删除线显示），再次点击删除将永久删除。`)
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
