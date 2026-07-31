path = '/Users/xzr/Desktop/workstep/apps/web/src/pages/TaskDetail.tsx'
with open(path) as f:
    content = f.read()

# 1. import updateTaskDescription
content = content.replace(
    "  const runTask = useTaskStore((s) => s.runTask)",
    "  const runTask = useTaskStore((s) => s.runTask)\n  const updateTaskDescription = useTaskStore((s) => s.updateTaskDescription)"
)

# 2. Add review editing states after showPromptEditor
content = content.replace(
    "  const [showPromptEditor, setShowPromptEditor] = useState(false)",
    "  const [showPromptEditor, setShowPromptEditor] = useState(false)\n  const [editReviewAuto, setEditReviewAuto] = useState(false)\n  const [editReviewRetries, setEditReviewRetries] = useState(1)\n  const [editReviewPrompt, setEditReviewPrompt] = useState('')\n  const [editReviewSaved, setEditReviewSaved] = useState(false)"
)

# 3. Add useEffect after promptDraft effect
old_effect = "  useEffect(() => {\n    setPromptDraft(currentStage.prompt)"
new_effect = "  useEffect(() => {\n    const cfg = (task?.review_overrides || {})[currentStage.key]\n    setEditReviewAuto(cfg?.auto ?? false)\n    setEditReviewRetries(cfg?.maxRetries ?? 1)\n    setEditReviewPrompt(cfg?.prompt ?? '')\n    setEditReviewSaved(false)\n  }, [currentStage.key, task?.review_overrides])\n\n  useEffect(() => {\n    setPromptDraft(currentStage.prompt)"
content = content.replace(old_effect, new_effect)

# 4. Insert review config section after stage prompt section
old_section = """              </div>
            </div>

          {/* Prompt section */}"""
new_section = """              </div>
            </div>

          {/* Per-stage review config (editable) */}
          <div style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {'\u9636\u6bb5\u5ba1\u6838\u914d\u7f6e'}
              </div>
              <button className="btn-ghost"
                onClick={async () => {
                  const updated = { ...(task.review_overrides || {}), [currentStage.key]: { auto: editReviewAuto, maxRetries: editReviewRetries, prompt: editReviewPrompt } }
                  await updateTaskDescription(task.id, task.description || '', projectId!, updated)
                  setEditReviewSaved(true)
                  setTimeout(() => setEditReviewSaved(false), 2000)
                }}
                style={{ height: 24, padding: '0 8px', fontSize: 11, gap: 3, color: 'var(--accent)' }}
              >{editReviewSaved ? '\u2713 \u5df2\u4fdd\u5b58' : '\u4fdd\u5b58'}</button>
            </div>
            <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={editReviewAuto} onChange={(e) => setEditReviewAuto(e.target.checked)} style={{ accentColor: 'var(--accent)', width: 13, height: 13, margin: 0 }} />
                  {'\u81ea\u52a8\u542f\u52a8\u5ba1\u6838 Agent'}
                </label>
                <span style={{ fontSize: 12, color: 'var(--meta)' }}>{'\u6700\u5927\u91cd\u8bd5'}</span>
                <input type="number" min={1} max={5} value={editReviewRetries} onChange={(e) => setEditReviewRetries(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                  style={{ width: 40, height: 22, fontSize: 12, padding: '0 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--fg)' }} />
              </div>
              <textarea
                value={editReviewPrompt}
                onChange={(e) => setEditReviewPrompt(e.target.value)}
                placeholder={'\u5ba1\u6838\u63d0\u793a\u8bcd\uff08\u7559\u7a7a\u4f7f\u7528\u9636\u6bb5\u9ed8\u8ba4\uff09'}
                rows={2}
                style={{ width: '100%', fontSize: 12, lineHeight: 1.5, resize: 'vertical', fontFamily: 'var(--font-body)', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', color: 'var(--fg)' }}
              />
            </div>
          </div>

          {/* Prompt section */}"""
content = content.replace(old_section, new_section)

with open(path, 'w') as f:
    f.write(content)
print("Clean patch applied")
