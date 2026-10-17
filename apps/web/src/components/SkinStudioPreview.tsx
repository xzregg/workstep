import { useEffect, useMemo, useRef, useState } from 'react'
import { compileSkin, resolvedSkinLayout, type SkinDocument } from '../skins/contract'
import { useI18n } from '../i18n'
import './SkinStudioPreview.css'
import {composerSendMarkup} from '../skins/composerSendGlyphs'

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

/** A separate document keeps draft CSS and tokens away from the live conversation. */
export default function SkinStudioPreview({ skin, compact, scene = 'chat', variant = 'studio' }: { skin: SkinDocument; compact: boolean; scene?: 'chat' | 'tasks' | 'flow'; variant?: 'studio' | 'center' }) {
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
    const chat = `<div class="preview-conversation" data-ui="conversation-layout" data-composer-position="${compact ? 'bottom' : layout.composerPosition}"><div class="chat-message-row" data-ui="messages"><div data-ui="message"><p>✧ ${escape(t('skins.sampleMessage'))}</p><p>${escape(t('skins.sampleText'))}</p><p class="preview-done">✓ ${escape(t('skins.independent'))}</p></div></div><div class="chat-input-frame" data-ui="composer">${layout.engineAppearance === 'cards' ? '<div class="engine-options"><button class="skin-select-option">Codex SDK</button><button class="skin-select-option">Claude Code</button></div>' : ''}<textarea placeholder="${escape(t('skins.sampleInput'))}"></textarea><div class="chat-input-toolbar"><select class="ws-select"><option>Codex SDK</option><option>Claude Code</option></select><button class="btn chat-input-send" aria-label="${escape(t('chatInput.send'))}">${composerSendMarkup(layout.composerSendIcon)}</button></div></div></div>`
    const tasks = `<div class="preview-board"><section><h3>待处理</h3><article class="task-card">整理今天的工作<br><small>准备开始</small></article><article class="task-card">检查移动端布局<br><small>设计检查</small></article></section><section><h3>进行中</h3><article class="task-card">制作我的皮肤<br><small>正在制作</small></article></section></div>`
    const flow = '<div class="preview-flow"><div class="flow-node">需求整理</div><span>→</span><div class="flow-node active">样式制作</div><span>→</span><div class="flow-node">检查效果</div></div>'
    const content = scene === 'tasks' ? tasks : scene === 'flow' ? flow : chat
    const menus = (position: string) => `<div class="preview-menus preview-menus-${position}">${(skin.menus ?? []).filter(menu => (menu.position ?? 'right') === position).map(menu => `<nav data-ui="extension-menu"><span>${escape(menu.label)}</span>${menu.items.map(item => `<button type="button">${escape(item.label)}</button>`).join('')}</nav>`).join('')}</div>`

    return `<!doctype html><html data-skin-id="${escape(skin.manifest.id)}"><head><base href="${escape(base)}/"><style>
      :root{--bg:#fff;--surface:#f5f5f7;--fg:#1d1d1f;--muted:#86868b;--border:#e8e8ed;--accent:#0071e3;--accent-fg:#fff;--radius-md:8px;font:11px system-ui;--font-body:system-ui;--preview-font-scale:${({inherit:1,small:.9,standard:1,large:1.1,extraLarge:1.2})[layout.fontSize]}}
      *{box-sizing:border-box}body{font-family:var(--font-body);margin:0;background:var(--bg);color:var(--fg)}button,textarea,select{font:inherit;color:inherit}
      .preview-chrome{height:78px;padding:0 28px;display:flex;align-items:center;gap:14px;background:var(--surface);border-bottom:1px solid var(--border);font-size:22px;color:var(--muted)}.preview-chrome i{width:12px;height:12px;border-radius:50%;background:var(--muted);opacity:.35}.preview-chrome span{flex:1;text-align:center}
      .app-shell{height:calc(100vh - 78px);display:flex}.layout-sidebar{width:210px;padding:34px 22px;background:var(--surface);border-right:1px solid var(--border);font-size:24px;${layout.sidebarSide === 'right' ? 'order:2;border-left:1px solid var(--border);border-right:0;' : ''}}
      .layout-sidebar p{color:var(--muted);margin:38px 0;font-size:22px}.app-main{${layout.backgroundGlow === 'accent' ? 'background-image:radial-gradient(ellipse at 100% 0%,color-mix(in srgb,var(--accent) 12%,transparent),transparent 65%);' : ''}flex:1;padding:28px;display:flex;flex-direction:column;min-width:0;gap:24px;font-size:32px}
      .chat-message-row{padding:24px;border:1px solid var(--border);border-radius:var(--radius-md);font-size:24px;line-height:1.7;flex:1;overflow:auto}.chat-message-row p{margin:0 0 22px}.preview-done{color:#439b75}
      .chat-input-frame{padding:20px;border:1px solid var(--border);border-radius:var(--radius-md);display:flex;flex-direction:column;gap:20px}
      .chat-input-send svg{width:28px;height:28px}
      textarea{width:100%;height:60px;resize:none;background:none;border:0;outline:0;font-size:24px}.chat-input-toolbar{display:flex;justify-content:space-between;gap:16px;${layout.composerToolsPosition === 'top' ? 'order:-1;' : ''}}
      .ws-select{font-size:24px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px;max-width:300px}.btn{background:var(--accent);color:var(--accent-fg);border:0;border-radius:12px;padding:10px 20px;font-size:24px}
      .engine-options{display:flex;gap:12px}.skin-select-option{padding:14px;border:1px solid var(--border);background:var(--surface);border-radius:12px;font-size:24px}
      .preview-board{display:grid;grid-template-columns:1fr 1fr;gap:22px;flex:1}.preview-board h3{font-size:24px;color:var(--muted)}.task-card{padding:26px;border:1px solid var(--border);border-radius:var(--radius-md);font-size:24px;margin-bottom:24px}.task-card small{color:var(--muted);font-size:20px;line-height:2}
      .preview-flow{flex:1;display:flex;gap:20px;align-items:center;justify-content:center;font-size:30px}.flow-node{padding:30px 20px;border:1px solid var(--border);border-radius:var(--radius-md);font-size:23px}.flow-node.active{border-color:var(--accent);color:var(--accent);background:var(--surface)}
      @media(max-width:1023px){.chat-input-send svg{width:16px;height:16px}.preview-chrome{height:36px;padding:0 12px;font-size:11px}.preview-chrome i{width:5px;height:5px}.app-shell{height:calc(100vh - 36px)}.layout-sidebar{display:none}.app-main{padding:18px;gap:16px;font-size:19px}.chat-message-row{font-size:14px;padding:16px}.chat-input-frame{padding:12px;gap:12px}textarea{font-size:14px}.ws-select{font-size:13px;max-width:180px}.btn{font-size:15px;padding:8px 14px}.skin-select-option{font-size:13px;padding:10px}.task-card{font-size:15px;padding:14px}.task-card small,.preview-board h3{font-size:13px}.preview-flow{flex-direction:column;gap:16px}.flow-node{font-size:16px;padding:20px}.preview-flow>span{transform:rotate(90deg)}}
      ${variant === 'center' ? '@media(min-width:1024px){.preview-chrome{height:36px;font-size:15px;padding:0 18px;gap:8px}.preview-chrome i{width:7px;height:7px}.app-shell{height:calc(100vh - 36px)}.layout-sidebar{width:170px;font-size:18px;padding:24px 18px}.layout-sidebar p{font-size:16px;margin:30px 0}.app-main{font-size:21px;padding:20px;gap:18px}.chat-message-row{font-size:16px;padding:18px}.chat-message-row p{margin-bottom:15px}.chat-input-frame{padding:14px;gap:12px}textarea{font-size:16px;height:45px}.ws-select,.btn,.skin-select-option{font-size:15px}.preview-board h3,.task-card{font-size:16px}.task-card small{font-size:13px}.flow-node{font-size:16px;padding:24px 16px}}' : ''}
      .preview-workspace{height:calc(100vh - 78px);display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:auto minmax(0,1fr) auto;grid-template-areas:"top top top" "left main right" "bottom bottom bottom"}.preview-workspace>.app-shell{grid-area:main;height:100%;min-height:0}.preview-menus:empty{display:none}.preview-menus-top{grid-area:top}.preview-menus-bottom{grid-area:bottom}.preview-menus-left{grid-area:left}.preview-menus-right{grid-area:right}.preview-menus nav{display:flex;flex-direction:column;gap:8px;padding:8px;background:var(--surface);font-size:12px}.preview-menus-top nav,.preview-menus-bottom nav{flex-direction:row;align-items:center}.preview-menus button{padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg)}
      .preview-conversation{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px}.preview-conversation[data-composer-position="top"]>[data-ui="composer"]{order:-1}@media(min-width:1024px){.preview-conversation[data-composer-position="left"]{display:grid;grid-template-columns:40% minmax(0,1fr)}.preview-conversation[data-composer-position="left"]>[data-ui="composer"]{order:-1}.preview-conversation[data-composer-position="right"]{display:grid;grid-template-columns:minmax(0,1fr) 40%}.preview-conversation>[data-ui="composer"]{min-width:0}}
      @media(max-width:1023px){.preview-workspace{height:calc(100vh - 36px)}}
      ${variant === 'center' ? '@media(min-width:1024px){.preview-workspace{height:calc(100vh - 36px)}}' : ''}
      ${css.replaceAll('<', '\\3c ')}
      </style></head><body><div class="preview-chrome"><i></i><i></i><i></i><span>WorkStep · 我的工作台</span></div><div class="preview-workspace" data-ui="workspace">${menus('top')}${menus('left')}<div class="app-shell" data-ui="app-shell"><aside class="layout-sidebar" data-ui="navigation"><b>W WorkStep</b><p>我的项目</p><p>项目对话</p><p>工作流程</p></aside><main class="app-main" data-ui="main"><strong>${escape(t(scene === 'chat' ? 'skins.studioSampleTitle' : `skins.scene_${scene}`))}</strong>${content}</main></div>${menus('right')}${menus('bottom')}</div></body></html>`.replace(/font-size:(\d+)px/g, 'font-size:calc($1px * var(--preview-font-scale))')
  }, [skin, compact, scene, variant, t])
  const viewportWidth = compact ? 390 : 1024
  const height = compact ? 620 : variant === 'center' ? 500 : 680
  const scale = (compact ? Math.min(width, 220) : width) / viewportWidth
  return <div ref={ref} className="skin-studio-preview-container"><div className={`skin-studio-preview-frame${compact ? ' is-phone' : ''}`} style={{ width: viewportWidth * scale, height: height * scale }}><iframe title={t('skins.studioPreview')} className="skin-studio-preview" style={{ width: viewportWidth, height, transform: `scale(${scale})` }} sandbox="allow-same-origin" srcDoc={source} /></div></div>
}
