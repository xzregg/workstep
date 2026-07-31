path = '/Users/xzr/Desktop/workstep/apps/web/src/pages/TaskDetail.tsx'
with open(path) as f:
    content = f.read()

# Insert task review config section after "阶段提示词" section end and before split handle
old = """            </div>
        </div>

        <div
          role="separator"
          tabIndex={0}
          aria-label="调整任务详情左右分栏\""""

new = """            </div>

          {/* Task-level review config */}
          {task.review_overrides && Object.keys(task.review_overrides).length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
                任务审核配置
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(task.review_overrides as Record<string, any>).map(([key, cfg]: [string, any]) => {
                  const stage = task.steps?.find((s: any) => s.step_key === key)
                  const laneColor = (stages || []).find((s: any) => (s.type || s.key) === key)?.color || '#888'
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
                          {cfg.auto ? '\u{1f504} 自动审核' : '\u270b 人工审核'} &middot; 重试{cfg.maxRetries || 1}次
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
          )}
        </div>

        <div
          role="separator"
          tabIndex={0}
          aria-label="调整任务详情左右分栏\""""

content = content.replace(old, new)

with open(path, 'w') as f:
    f.write(content)
print("Patched TaskDetail")
