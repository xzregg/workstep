"""Rebuild TaskList.tsx with all features from the baseline committed version."""
import re

PATH = '/Users/xzr/Desktop/workstep/apps/web/src/pages/TaskList.tsx'
with open(PATH) as f:
    content = f.read()

# ============================================================
# 1. Add imports
# ============================================================
content = content.replace(
    "import ConfirmDialog from '../components/ConfirmDialog'",
    "import ConfirmDialog from '../components/ConfirmDialog'\nimport MarkdownMessage from '../components/MarkdownMessage'"
)

# ============================================================
# 2. Add state variables after newTitle
# ============================================================
old_state = "  const [newTitle, setNewTitle] = useState('')\n  const [newDesc, setNewDesc] = useState('')"
new_state = """  const [newTitle, setNewTitle] = useState('')
  const [createError, setCreateError] = useState('')
  const [activeTab, setActiveTab] = useState<'content' | 'review'>('content')
  const [newDesc, setNewDesc] = useState('')
  const [descMode, setDescMode] = useState<'edit' | 'preview'>('edit')
  const descInputRef = useRef<HTMLTextAreaElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)"""
content = content.replace(old_state, new_state)

# ============================================================
# 3. Add workflow name and reviewOverrides after directoryOpeners logic
# ============================================================
# Find where activeProject is declared and add workflow info
content = content.replace(
    "  const activeProject = useProjectStore((s) => s.activeProject)",
    "  const activeProject = useProjectStore((s) => s.activeProject)\n  const activeWorkflowId = useProjectStore((s) => s.activeWorkflowId)\n  const activeWorkflowName = activeProject?.workflows?.find((w) => w.id === activeWorkflowId)?.name"
)

# ============================================================
# 4. Add reviewOverrides state and openNewPanel logic
# ============================================================
old_review_init = """  const openNewPanel = (stepKey?: string) => {
    setCreateStartStepKey(stepKey || lanes[0]?.key || null)
    setNewTitle('')
    setNewDesc('')
    setShowNewPanel(true)
  }"""

new_review_init = """  const openNewPanel = (stepKey?: string) => {
    setCreateStartStepKey(stepKey || lanes[0]?.key || null)
    setNewTitle('')
    setNewDesc('')
    setCreateError('')
    setActiveTab('content')
    // Initialize review overrides from canvas stage config
    const nodeConfigs: Record<string, { auto: boolean; prompt: string; maxRetries: number }> = {}
    const canvasSteps = activeProject?.steps
    if (canvasSteps?.nodes) {
      for (const n of canvasSteps.nodes) {
        const key = (n.type || n.key || String(n.id)) as string
        const rv = n.review || {}
        nodeConfigs[key] = {
          auto: !!rv.auto,
          prompt: String(rv.prompt || ''),
          maxRetries: Math.max(1, Math.min(5, Number(rv.maxRetries) || 1)),
        }
      }
    }
    setReviewOverrides(nodeConfigs)
    setShowNewPanel(true)
  }"""
content = content.replace(old_review_init, new_review_init)

# Add reviewOverrides state before openNewPanel
content = content.replace(
    "  // Backend step progress is the source of truth",
    "  const [reviewOverrides, setReviewOverrides] = useState<Record<string, { auto: boolean; prompt: string; maxRetries: number }>>({})\n\n  // Backend step progress is the source of truth"
)

# ============================================================
# 5. Update handleCreate with error handling and review overrides
# ============================================================
old_handle = """  const handleCreate = async () => {
    if (!newTitle.trim() || !activeProject) return
    try {
      await createTask(
        newTitle.trim(),
        activeProject.path,
        activeProject.id,
        newDesc.trim() || undefined,
        createLane?.key,
      )
      setNewTitle('')
      setNewDesc('')
      setShowNewPanel(false)
    } catch (e) { console.error('Create failed:', e) }
  }"""

new_handle = """  const handleCreate = async () => {
    if (!newTitle.trim() || !activeProject) return
    try {
      await createTask(
        newTitle.trim(),
        activeProject.path,
        activeProject.id,
        newDesc.trim() || undefined,
        createLane?.key,
        Object.keys(reviewOverrides).length > 0 ? reviewOverrides : undefined,
      )
      setNewTitle('')
      setNewDesc('')
      setShowNewPanel(false)
      setCreateError('')
    } catch (e: any) {
      setCreateError(e?.message || '创建任务失败，请检查后台服务是否正常')
    }
  }"""

# Use regex because template literal in the old string might have subtle differences
content = re.sub(
    r'  const handleCreate = async \(\) => \{\n.*?\n  \}',
    new_handle,
    content,
    flags=re.DOTALL
)

# ============================================================
# 6. Add image handlers
# ============================================================
image_handlers = """
  const insertImageMarkdown = (dataUrl: string, alt = '图片') => {
    const snippet = '![' + alt + '](' + dataUrl + ')'
    const ta = descInputRef.current
    if (ta) {
      const start = ta.selectionStart ?? newDesc.length
      const end = ta.selectionEnd ?? newDesc.length
      const next = newDesc.slice(0, start) + snippet + newDesc.slice(end)
      setNewDesc(next)
      requestAnimationFrame(() => {
        ta.focus()
        const pos = start + snippet.length
        ta.setSelectionRange(pos, pos)
      })
    } else {
      setNewDesc((d) => d + (d && !d.endsWith('\\n') ? '\\n' : '') + snippet)
    }
  }

  const handleImageFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => insertImageMarkdown(String(reader.result))
    reader.readAsDataURL(file)
  }

  const handleDescPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgItem = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'))
    if (imgItem) {
      e.preventDefault()
      const file = imgItem.getAsFile()
      if (file) handleImageFile(file)
    }
  }"""

content = content.replace(
    '  const deleteCard = async (e: React.MouseEvent, taskId: string) => {',
    image_handlers + '\n  const deleteCard = async (e: React.MouseEvent, taskId: string) => {'
)

# ============================================================
# 7. Add workflow name in topbar
# ============================================================
old_topbar = """        <button className="btn-primary" onClick={() => openNewPanel()} style={{ fontSize: 13, gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建任务
        </button>"""

new_topbar = """        <button className="btn-primary" onClick={() => openNewPanel()} style={{ fontSize: 13, gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建任务
        </button>
        {activeWorkflowName && (
          <span
            title={activeWorkflowName}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 13, color: 'var(--fg-2)', fontWeight: 500,
              maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
              <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
            </svg>
            {activeWorkflowName}
          </span>
        )}"""
content = content.replace(old_topbar, new_topbar)

# ============================================================
# 8. Move addCard button from bottom to top of lane body
# ============================================================
content = content.replace(
    '                <button style={addCardStyle} onClick={() => openNewPanel(lane.key)}>+ 添加{lane.label}任务</button>\n              </div>',
    '              </div>'
)

# Add at top of lane body
old_lane_start = """              <div
                style={{
                  ...laneBodyStyle,
                  background: dragOverLane === lane.key ? 'color-mix(in oklab, var(--accent), transparent 94%)' : 'transparent',
                }}
                onDragOver={(e) => onDragOver(e, lane.key)}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, lane.key)}
              >
                {laneTasks.map((t: any) => {"""

new_lane_start = """              <div
                style={{
                  ...laneBodyStyle,
                  background: dragOverLane === lane.key ? 'color-mix(in oklab, var(--accent), transparent 94%)' : 'transparent',
                }}
                onDragOver={(e) => onDragOver(e, lane.key)}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, lane.key)}
              >
                <button style={addCardStyle} onClick={() => openNewPanel(lane.key)}>+ 添加{lane.label}任务</button>
                {laneTasks.map((t: any) => {"""

content = content.replace(old_lane_start, new_lane_start)

# ============================================================
# 9. Replace new task panel with tabbed version
# ============================================================
old_panel = """        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {createLaneIndex > 0 && (
            <div style={{
              marginBottom: 10, padding: '11px 12px', borderRadius: 8,
              background: `color-mix(in oklab, ${createLane?.color || 'var(--accent)'}, transparent 91%)`,
              borderLeft: `3px solid ${createLane?.color || 'var(--accent)'}`,
              color: 'var(--fg-2)', fontSize: 12, lineHeight: 1.55,
            }}>
              此任务将直接从"${createLane?.label}"阶段开始。
              之前的 ${lanes.slice(0, createLaneIndex).map((lane) => `"${lane.label}"`).join('、')}
              阶段会标记为已跳过，不读取这些阶段的输出物。
            </div>
          )}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>任务标题</label>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="输入标题..."
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginTop: 8 }}>任务说明</label>
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder={`输入${createLane?.label || '当前阶段'}任务说明...`}
            style={{ minHeight: 160, resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }}
          />
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={() => setShowNewPanel(false)}>取消</button>
          <button className="btn-primary" onClick={handleCreate}>创建</button>
        </div>"""

new_panel = """        {/* ── Tab bar ── */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-soft)', padding: '0 16px', gap: 0, flexShrink: 0 }}>
          <button
            onClick={() => setActiveTab('content')}
            style={{
              padding: '10px 16px', fontSize: 13, fontWeight: activeTab === 'content' ? 600 : 400,
              border: 'none', borderBottom: activeTab === 'content' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              color: activeTab === 'content' ? 'var(--fg)' : 'var(--meta)',
              fontFamily: 'var(--font-body)',
            }}
          >任务内容</button>
          <button
            onClick={() => setActiveTab('review')}
            style={{
              padding: '10px 16px', fontSize: 13, fontWeight: activeTab === 'review' ? 600 : 400,
              border: 'none', borderBottom: activeTab === 'review' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              color: activeTab === 'review' ? 'var(--fg)' : 'var(--meta)',
              fontFamily: 'var(--font-body)',
            }}
          >审核配置</button>
        </div>

        {/* ── Tab: Task Content ── */}
        {activeTab === 'content' && (
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {createLaneIndex > 0 && (
            <div style={{
              marginBottom: 10, padding: '11px 12px', borderRadius: 8,
              background: 'color-mix(in oklab, ' + (createLane?.color || 'var(--accent)') + ', transparent 91%)',
              borderLeft: '3px solid ' + (createLane?.color || 'var(--accent)'),
              color: 'var(--fg-2)', fontSize: 12, lineHeight: 1.55,
            }}>
              此任务将直接从\u201c{createLane?.label}\u201d阶段开始。
              之前的 {lanes.slice(0, createLaneIndex).map((lane) => '\u201c' + lane.label + '\u201d').join('\u3001')}
              阶段会标记为已跳过，不读取这些阶段的输出物。
            </div>
          )}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>任务标题</label>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="输入标题..."
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginTop: 8 }}>任务说明</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              <button
                onClick={() => setDescMode('edit')}
                style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: descMode === 'edit' ? 'var(--accent)' : 'transparent', color: descMode === 'edit' ? '#fff' : 'var(--fg-2)', fontFamily: 'var(--font-body)' }}
              >编辑</button>
              <button
                onClick={() => setDescMode('preview')}
                style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: descMode === 'preview' ? 'var(--accent)' : 'transparent', color: descMode === 'preview' ? '#fff' : 'var(--fg-2)', fontFamily: 'var(--font-body)' }}
              >预览</button>
            </div>
            <button className="btn-ghost" onClick={() => imgInputRef.current?.click()} style={{ fontSize: 12, padding: '3px 8px', gap: 4 }}>
              \U0001f5bc 图片
            </button>
            <span style={{ fontSize: 11, color: 'var(--meta)' }}>支持 Markdown，可粘贴/插入图片</span>
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = '' }}
            />
          </div>
          {descMode === 'edit' ? (
            <textarea
              ref={descInputRef}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              onPaste={handleDescPaste}
              placeholder={'输入' + (createLane?.label || '当前阶段') + '任务说明...（支持 Markdown，可直接粘贴图片）'}
              style={{ minHeight: 160, resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }}
            />
          ) : (
            <div style={{
              minHeight: 160, maxHeight: '45vh', overflowY: 'auto', padding: '10px 12px',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)', fontSize: 13, lineHeight: 1.6,
            }}>
              {newDesc.trim() ? <MarkdownMessage content={newDesc} /> : <span style={{ color: 'var(--meta)', fontStyle: 'italic' }}>暂无内容</span>}
            </div>
          )}
        </div>
        )}

        {/* ── Tab: Review Config ── */}
        {activeTab === 'review' && (
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Object.keys(reviewOverrides).length === 0 ? (
            <div style={{ color: 'var(--meta)', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>
              当前流程暂无阶段审核配置
            </div>
          ) : (
            Object.entries(reviewOverrides).map(([key, cfg]) => {
              const lane = lanes.find((l) => l.key === key)
              const label = lane?.label || key
              const color = lane?.color || '#888'
              const laneIdx = lanes.findIndex((l) => l.key === key)
              const isUpstream = createLaneIndex >= 0 && laneIdx >= 0 && laneIdx < createLaneIndex
              return React.createElement('div', {
                key,
                style: {
                  padding: '10px 12px', borderRadius: 8,
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid ' + (isUpstream ? 'var(--border)' : color),
                  display: 'flex', flexDirection: 'column', gap: 8,
                  opacity: isUpstream ? 0.45 : 1,
                }
              },
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  React.createElement('span', {
                    style: { fontSize: 13, fontWeight: 600, color: isUpstream ? 'var(--meta)' : 'var(--fg)' }
                  }, label),
                  isUpstream && React.createElement('span', {
                    style: { fontSize: 10, color: 'var(--meta)', background: 'var(--surface)', padding: '1px 6px', borderRadius: 3 }
                  }, '已跳过')
                ),
                React.createElement('label', {
                  style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: isUpstream ? 'var(--meta)' : 'var(--fg-2)', cursor: isUpstream ? 'default' : 'pointer' }
                },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: cfg.auto,
                    disabled: isUpstream,
                    onChange: () => !isUpstream && setReviewOverrides(prev => ({ ...prev, [key]: { ...prev[key], auto: !prev[key].auto } })),
                    style: { accentColor: 'var(--accent)' }
                  }),
                  '自动启动审核 Agent'
                ),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  React.createElement('span', { style: { fontSize: 12, color: 'var(--meta)' } }, '最大重试'),
                  React.createElement('input', {
                    type: 'number',
                    min: 1, max: 5,
                    value: cfg.maxRetries,
                    disabled: isUpstream,
                    onChange: (e) => {
                      if (isUpstream) return
                      const v = Math.max(1, Math.min(5, Number(e.target.value) || 1))
                      setReviewOverrides(prev => ({ ...prev, [key]: { ...prev[key], maxRetries: v } }))
                    },
                    style: { width: 48, height: 24, fontSize: 12, padding: '0 6px', border: '1px solid var(--border)', borderRadius: 4, background: isUpstream ? 'var(--surface)' : 'var(--bg)', color: isUpstream ? 'var(--meta)' : 'var(--fg)' }
                  })
                ),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  React.createElement('span', { style: { fontSize: 12, color: 'var(--meta)' } }, '审核提示词'),
                  React.createElement('textarea', {
                    value: cfg.prompt,
                    disabled: isUpstream,
                    onChange: (e) => !isUpstream && setReviewOverrides(prev => ({ ...prev, [key]: { ...prev[key], prompt: e.target.value } })),
                    placeholder: '留空则使用阶段默认审核要求',
                    rows: 2,
                    style: { width: '100%', fontSize: 12, lineHeight: 1.5, resize: 'vertical', fontFamily: 'var(--font-body)', opacity: isUpstream ? 0.6 : 1 }
                  })
                )
              )
            })
          )}
        </div>
        )}

        {/* ── Error / Footer ── */}
        {createError && (
          <div style={{ padding: '8px 16px 0', fontSize: 12, color: 'var(--danger)' }}>{createError}</div>
        )}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={() => setShowNewPanel(false)}>取消</button>
          <button className="btn-primary" onClick={handleCreate}>创建</button>
        </div>"""

content = content.replace(old_panel, new_panel)

# ============================================================
# Write back
# ============================================================
with open(PATH, 'w') as f:
    f.write(content)

print(f'Written {len(content)} chars to {PATH}')
