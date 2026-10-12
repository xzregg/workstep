import { useEffect, useMemo, useRef, useState } from 'react'
import { compileSkin, resolvedSkinLayout, type SkinDocument } from '../skins/contract'
import { useI18n } from '../i18n'

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

/** A separate document keeps draft CSS and tokens away from the live conversation. */
export default function SkinStudioPreview({ skin, compact }: { skin: SkinDocument; compact: boolean }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(260)
  useEffect(() => {
    const measure = () => { if (ref.current) setWidth(ref.current.clientWidth || 260) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (ref.current) observer?.observe(ref.current)
    return () => observer?.disconnect()
  }, [])
  const source = useMemo(() => {
    const css = compileSkin(skin)
    const layout = resolvedSkinLayout(skin, compact)
    const base = window.location.origin
    return `<!doctype html><html data-skin-id="${escape(skin.manifest.id)}"><head><base href="${escape(base)}/"><style>
      :root{--bg:#fff;--surface:#f5f5f7;--fg:#1d1d1f;--muted:#86868b;--border:#e8e8ed;--accent:#0071e3;--accent-fg:#fff;--radius-md:8px;font:11px system-ui}
      *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}button,textarea,select{font:inherit;color:inherit}
      .app-shell{height:100vh;display:flex}.layout-sidebar{width:70px;padding:12px 6px;background:var(--surface);border-right:1px solid var(--border);font-size:8px}
      .layout-sidebar p{color:var(--muted);margin:18px 0}.app-main{flex:1;padding:10px;display:flex;flex-direction:column;min-width:0;gap:12px}
      .chat-message-row{padding:10px;border:1px solid var(--border);border-radius:var(--radius-md);font-size:10px;line-height:1.7;flex:1;overflow:auto}.chat-message-row p{margin:0 0 10px}
      .chat-input-frame{padding:8px;border:1px solid var(--border);border-radius:var(--radius-md);display:flex;flex-direction:column;gap:8px}
      textarea{width:100%;height:35px;resize:none;background:none;border:0;outline:0;font-size:10px}.chat-input-toolbar{display:flex;justify-content:space-between;gap:6px}
      .ws-select{font-size:9px;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:4px;max-width:110px}.btn{background:var(--accent);color:var(--accent-fg);border:0;border-radius:5px;padding:4px 8px}
      .engine-options{display:flex;gap:4px;margin-bottom:6px}.skin-select-option{padding:5px;border:1px solid var(--border);background:var(--surface);border-radius:5px;font-size:9px}
      .layout-sidebar{width:180px;${layout.sidebarSide === 'right' ? 'order:2;border-left:1px solid var(--border);border-right:0;' : ''}}
      .chat-input-toolbar{${layout.composerToolsPosition === 'top' ? 'order:-1;' : ''}}
      .app-main{padding:30px;gap:26px;font-size:20px}.chat-message-row{padding:24px;font-size:18px}.chat-input-frame{padding:20px;gap:18px}textarea{height:90px;font-size:18px}.ws-select{font-size:16px;padding:10px;max-width:240px}.btn{padding:12px 18px}.layout-sidebar{font-size:15px;padding:26px 16px}.layout-sidebar p{margin:26px 0}.skin-select-option{font-size:15px;padding:14px}
      @media(max-width:1023px){.layout-sidebar{display:none}.app-main{padding:20px;gap:18px;font-size:17px}.chat-message-row{font-size:14px}.chat-input-frame{padding:12px}textarea{font-size:14px}.ws-select{font-size:13px}}
      ${css}
      </style></head><body><div class="app-shell"><aside class="layout-sidebar"><b>W WorkStep</b><p>我的项目</p><p>项目对话</p><p>工作流程</p></aside><main class="app-main"><strong>${escape(t('skins.studioSampleTitle'))}</strong><div class="chat-message-row"><p>✧ ${escape(t('skins.sampleMessage'))}</p><p>${escape(t('skins.sampleText'))}</p></div><div class="chat-input-frame">${layout.engineAppearance === 'cards' ? '<div class="engine-options"><button class="skin-select-option">Codex SDK</button><button class="skin-select-option">Claude Code</button></div>' : ''}<textarea placeholder="${escape(t('skins.sampleInput'))}"></textarea><div class="chat-input-toolbar"><select class="ws-select"><option>Codex SDK</option><option>Claude Code</option></select><button class="btn">↑</button></div></div></main></div></body></html>`
  }, [skin, compact, t])
  const viewportWidth = compact ? 390 : 1024
  const height = compact ? 620 : 850
  const scale = (compact ? Math.min(width, 220) : width) / viewportWidth
  return <div ref={ref} className="skin-studio-preview-container"><div className={`skin-studio-preview-frame${compact ? ' is-phone' : ''}`} style={{ width: viewportWidth * scale, height: height * scale }}><iframe title={t('skins.studioPreview')} className="skin-studio-preview" style={{ width: viewportWidth, height, transform: `scale(${scale})` }} sandbox="" srcDoc={source} /></div></div>
}
