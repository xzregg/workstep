path = '/Users/xzr/Desktop/workstep/apps/web/src/pages/TaskDetail.tsx'
with open(path) as f:
    content = f.read()

# Find and replace the bulk review config section
old = """          {task.review_overrides && Object.keys(task.review_overrides).length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
                任务审核配置
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(task.review_overrides as Record<string, any>).map(([key, cfg]: [string, any]) => {
                  const laneColor = (stages || []).find((s: any) => (s.type || s.key) === key)?.color || '#888'
                  const autoLabel = cfg.auto ? '\\u{1f504} 自动审核' : '\\u270b 人工审核'
                  return (
                    <div key={key} style={{
                      padding: '8px 10px', borderRadius: 6, fontSize: 12,
                      border: '1px solid var(--border)',
                      borderLeft: `3px solid ${laneColor}`,
                      background: 'var(--surface)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: cfg.prompt ? 4 : 0 }}>
                        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{key}</span>
                        <span style={{ fontSize: 11, color: 'var(--meta)' }}>
                          {autoLabel} &middot; 重试{cfg.maxRetries || 1}次
                        </span>
                      </div>
                      {cfg.prompt && (
                        <div style={{ fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.5, marginTop: 4, padding: '6px 8px', background: 'var(--bg)', borderRadius: 4, whiteSpace: 'pre-wrap' }}>
                          {cfg.prompt}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}"""

new = r"""          {/* Per-stage review config (editable) */}
          {(() => {
            const overrideKey = currentStage.key
            const overrideCfg = (task.review_overrides || {})[overrideKey]
            const [editAuto, setEditAuto] = useState(overrideCfg?.auto ?? false)
            const [editRetries, setEditRetries] = useState(overrideCfg?.maxRetries ?? 1)
            const [editPrompt, setEditPrompt] = useState(overrideCfg?.prompt ?? '')
            const [saved, setSaved] = useState(false)
            useEffect(() => {
              setEditAuto(overrideCfg?.auto ?? false)
              setEditRetries(overrideCfg?.maxRetries ?? 1)
              setEditPrompt(overrideCfg?.prompt ?? '')
              setSaved(false)
            }, [overrideKey, overrideCfg?.auto, overrideCfg?.maxRetries, overrideCfg?.prompt])
            const handleSave = async () => {
              const updated = { ...(task.review_overrides || {}), [overrideKey]: { auto: editAuto, maxRetries: editRetries, prompt: editPrompt } }
              await updateTaskDescription(task.id, descriptionDraft, projectId!, updated)
              setSaved(true)
              setTimeout(() => setSaved(false), 2000)
            }
            return (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  阶段审核配置
                </div>
                <button
                  className="btn-ghost"
                  onClick={handleSave}
                  style={{ height: 26, padding: '0 10px', fontSize: 11, gap: 4, color: saved ? 'var(--success)' : 'var(--accent)' }}
                >
                  {saved ? '\u2713 已保存' : '保存'}
                </button>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)', borderLeft: '3px solid ' + currentStageColor, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={editAuto} onChange={(e) => setEditAuto(e.target.checked)} style={{ accentColor: 'var(--accent)', width: 13, height: 13, margin: 0 }} />
                    自动审核
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <span style={{ color: 'var(--meta)' }}>重试</span>
                    <input type="number" min={1} max={5} value={editRetries} onChange={(e) => setEditRetries(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} style={{ width: 36, height: 22, fontSize: 11, padding: '0 4px', border: '1px solid var(--border)', borderRadius: 4, textAlign: 'center', background: 'var(--bg)', color: 'var(--fg)' }} />
                  </div>
                </div>
                <textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  placeholder="审核提示词（留空使用阶段默认）"
                  rows={2}
                  style={{ width: '100%', fontSize: 11, lineHeight: 1.5, resize: 'vertical', fontFamily: 'var(--font-body)', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--fg)' }}
                />
              </div>
            </div>
            )
          })()}"""

if old in content:
    content = content.replace(old, new)
    with open(path, 'w') as f:
        f.write(content)
    print("Replaced review config with editable per-stage version")
else:
    print("Pattern NOT found")
    # Show what's there
    idx = content.find('Task-level review')
    if idx > 0:
        print(content[idx:idx+100])
