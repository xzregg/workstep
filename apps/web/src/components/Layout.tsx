import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useWebSocket } from '../hooks/useWebSocket'
import DirectoryBrowser from './DirectoryBrowser'
import SettingsPage from '../pages/SettingsPage'
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
  border: `1.5px solid ${active ? 'var(--accent)' : 'transparent'}`,
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

interface Props {
  onSelectProject: (p: Project) => void
  children: React.ReactNode
}

export default function Layout({ onSelectProject, children }: Props) {
  useWebSocket()
  const [searchParams] = useSearchParams()
  const { projects, activeProject, fetchProjects, initProject, setActiveProject, renameProject } = useProjectStore()
  const [showInitModal, setShowInitModal] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [showBrowser, setShowBrowser] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => { fetchProjects() }, [fetchProjects])

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
            <div
              key={p.path}
              onClick={() => handleSelectProject(p)}
              onDoubleClick={(e) => { e.stopPropagation(); setRenameId(p.path); setRenameName(p.name) }}
              style={projectItemStyle(activeProject?.path === p.path)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              {renameId === p.path ? (
                <input
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && renameName.trim()) {
                      await renameProject(p.path, renameName.trim())
                      setRenameId(null)
                    }
                    if (e.key === 'Escape') setRenameId(null)
                  }}
                  onBlur={async () => {
                    if (renameName.trim() && renameName !== p.name) {
                      await renameProject(p.path, renameName.trim())
                    }
                    setRenameId(null)
                  }}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  style={{ flex: 1, height: 22, fontSize: 13, padding: '0 4px', border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                />
              ) : (
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </span>
              )}
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
    </div>
  )
}
