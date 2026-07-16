import { useState, useEffect } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { useWebSocket } from '../hooks/useWebSocket'
import type { Project } from '../api/client'

/* ── Sidebar styles ── */
const sidebarStyle: React.CSSProperties = {
  width: 280, minWidth: 280,
  background: 'var(--bg)',
  borderRight: '1px solid var(--border-soft)',
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
}

const navStyle: React.CSSProperties = {
  padding: '12px 14px 8px',
  display: 'flex', flexDirection: 'column', gap: 2,
  borderBottom: '1px solid var(--border-soft)',
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
  cursor: 'pointer',
  fontSize: 14,
  color: active ? 'var(--fg)' : 'var(--fg-2)',
  background: active ? 'var(--surface)' : 'transparent',
  border: `1.5px solid ${active ? 'var(--accent)' : 'transparent'}`,
  fontWeight: active ? 500 : 400,
  marginBottom: 2,
  transition: 'all var(--motion-fast)',
})

const addButtonStyle: React.CSSProperties = {
  margin: '8px 12px 12px',
  padding: 8,
  border: '1.5px dashed var(--border)',
  borderRadius: 'var(--radius-sm)',
  textAlign: 'center' as const,
  cursor: 'pointer',
  color: 'var(--meta)',
  fontSize: 12,
  background: 'transparent',
  width: 'calc(100% - 24px)',
  fontFamily: 'var(--font-body)',
}

interface Props {
  onSelectProject: (p: Project) => void
  children: React.ReactNode
}

export default function Layout({ onSelectProject, children }: Props) {
  useWebSocket()
  const { projects, activeProject, fetchProjects, initProject, setActiveProject } = useProjectStore()
  const [showInitModal, setShowInitModal] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { fetchProjects() }, [fetchProjects])

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
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <aside style={sidebarStyle}>
        {/* Brand */}
        <div style={navStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontWeight: 600, fontSize: 14, fontFamily: 'var(--font-display)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            WorkStep
          </div>
        </div>

        {/* Projects section */}
        <div style={sectionLabel}>
          项目
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
          {projects.map((p) => (
            <div
              key={p.path}
              onClick={() => handleSelectProject(p)}
              style={projectItemStyle(activeProject?.path === p.path)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
            </div>
          ))}
          {projects.length === 0 && (
            <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--meta)', fontStyle: 'italic' }}>
              还没有项目
            </div>
          )}
        </div>

        {/* Add project button */}
        <button style={addButtonStyle} onClick={() => setShowInitModal(true)}>
          + 添加项目
        </button>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </main>

      {/* Init project modal */}
      {showInitModal && (
        <div className="modal-overlay" onClick={() => setShowInitModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">初始化项目</span>
              <button className="btn-icon" onClick={() => setShowInitModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label>项目路径</label>
              <input
                placeholder="/Users/me/my-app"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
              />
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
              <button className="btn-ghost" onClick={() => setShowInitModal(false)}>取消</button>
              <button className="btn-primary" onClick={handleInit}>初始化</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
