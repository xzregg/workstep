import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fsApi, type DirectoryOpener } from '../api/client'
import { useI18n } from '../i18n'
import { useTaskFilePreview } from '../contexts/MarkdownAssetUrlContext'
import { copyText } from '../utils/clipboard'
import { gatewayFetch, gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { browserActorHeaders } from '../utils/browserActor'
import Spinner from './Spinner'
import { usesWebDirectoryBrowser } from '../utils/openLocation'
import './FileContextMenu.css'

export interface FileContextTarget { path: string; name: string; x: number; y: number }

export default function FileContextMenu({ target, projectId, projectRoot, localProject, onDismiss }: {
  target: FileContextTarget | null
  projectId?: string
  projectRoot?: string
  localProject: boolean
  onDismiss: () => void
}) {
  const { t } = useI18n()
  const filePreview = useTaskFilePreview()
  const menuRef = useRef<HTMLDivElement>(null)
  const [openers, setOpeners] = useState<DirectoryOpener[]>([])
  const [submenu, setSubmenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const hostActions = localProject && !gatewayWorkspacePath() && !window.location.pathname.startsWith('/share/')
    && !usesWebDirectoryBrowser('local', window.location.hostname, navigator.userAgent, Boolean(window.workstepDesktop?.files))
  const native = hostActions && Boolean(projectRoot && window.workstepDesktop?.files)
  const absolutePath = target && (/^(?:[a-z]:[\\/]|\/)/i.test(target.path) ? target.path
    : projectRoot ? `${projectRoot.replace(/[\\/]$/, '')}/${target.path.replace(/^\.\//, '')}` : target.path)

  useEffect(() => {
    if (!target) return
    setSubmenu(false)
    setNotice('')
    let active = true
    if (hostActions) (window.workstepDesktop?.directories?.openers() ?? fsApi.directoryOpeners()).then(result => {
      if (active) setOpeners(result.openers.filter(item => item.available))
    }).catch(() => { if (active) setOpeners([]) })
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onDismiss() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss() }
    }
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) onDismiss() }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', onDismiss)
    return () => {
      active = false
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', key)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', onDismiss)
    }
  }, [target, hostActions, onDismiss])

  useLayoutEffect(() => {
    if (!target) return
    const bounds = menuRef.current?.getBoundingClientRect()
    setPosition({ x: Math.max(8, Math.min(target.x, window.innerWidth - (bounds?.width || 220) - 8)),
      y: Math.max(8, Math.min(target.y, window.innerHeight - (bounds?.height || 220) - 8)) })
  }, [target, submenu, openers, notice, busy])

  const run = async (action: 'open' | 'reveal' | 'save' | 'path' | 'content', opener?: string) => {
    if (!target || busy) return
    setBusy(true)
    setNotice('')
    try {
      if (action === 'path') {
        if (!await copyText(absolutePath || target.path)) throw new Error(t('meta.copyFailed'))
      } else if (hostActions && (action === 'open' || action === 'reveal')) {
        if (native) await window.workstepDesktop!.files!.action(absolutePath!, action, opener)
        else await fsApi.openFile(target.path, projectId!, action === 'reveal' ? 'file_manager' : opener || 'default')
      } else if (native && action === 'save') {
        await window.workstepDesktop!.files!.action(absolutePath!, action, opener)
      } else {
        if (!projectId) throw new Error(t('fileMenu.projectRequired'))
        const url = filePreview ? filePreview.rawUrl(target.path) : fsApi.projectFileUrl(target.path, projectId)
        if (action === 'content') {
          const preview = await (filePreview ? filePreview.load(target.path) : fsApi.preview(target.path, projectId))
          if (preview.type !== 'text') throw new Error(t('fileMenu.textOnly'))
        }
        const response = await gatewayFetch(url, { headers: browserActorHeaders() })
        if (!response.ok) throw new Error(`${t('fileMenu.readFailed')} (${response.status})`)
        if (action === 'content') {
          if (!await copyText(await response.text())) throw new Error(t('meta.copyFailed'))
        } else {
          const blobUrl = URL.createObjectURL(await response.blob())
          const link = document.createElement('a')
          link.href = blobUrl
          link.download = target.name
          document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
        }
      }
      onDismiss()
      setNotice(action === 'path' || action === 'content' ? t('common.copied') : '')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  return <>
    {!target && notice && <span className="file-context-notice" role="status">{notice}</span>}
    {target && createPortal(<div ref={menuRef} className="file-context-popover"
      style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
        event.preventDefault()
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }}>
      <div className="file-context-menu" role="menu" aria-label={t('browser.fileActions')}>
      {hostActions && <>
        {openers.some(item => item.id === 'vscode') && <button autoFocus role="menuitem" disabled={busy} onClick={() => void run('open', 'vscode')}>{t('fileMenu.openInCode')}</button>}
        <button autoFocus={!openers.some(item => item.id === 'vscode')} role="menuitem" disabled={busy} aria-haspopup="menu" aria-expanded={submenu}
          onMouseEnter={() => setSubmenu(true)} onClick={() => setSubmenu(value => !value)}
          onKeyDown={event => { if (event.key === 'ArrowRight') {
            event.preventDefault()
            setSubmenu(true)
            window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('.file-context-submenu button')?.focus(), 0)
          } }}>{t('fileMenu.openWith')} <span>›</span></button>
        <div className="file-context-divider" role="separator" />
      </>}
      <button autoFocus={!hostActions} role="menuitem" disabled={busy || !projectId} onClick={() => void run('save')}>{t('fileMenu.saveAs')}</button>
      <button role="menuitem" disabled={busy} onClick={() => void run('path')}>{t('fileMenu.copyPath')}</button>
      <button role="menuitem" disabled={busy || !projectId} onClick={() => void run('content')}>{t('fileMenu.copyContent')}</button>
      {hostActions && <button role="menuitem" disabled={busy} onClick={() => void run('reveal')}>{t('fileMenu.reveal', { app: openers.find(item => item.id === 'file_manager')?.label || t('taskList.openLocation') })}</button>}
      {busy && <div className="file-context-feedback" role="status"><Spinner size={14} />{t('common.loading')}</div>}
      {notice && <div className="file-context-feedback" role="alert">{notice}</div>}
      </div>
        {hostActions && submenu && <div className="file-context-menu file-context-submenu" role="menu" aria-label={t('fileMenu.openWith')}
          onKeyDown={event => { if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setSubmenu(false)
            menuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus()
          } }}>
          {[...openers.filter(item => item.id !== 'file_manager'), { id: 'default', label: t('fileMenu.defaultApp'), available: true },
            ...openers.filter(item => item.id === 'file_manager')].map(item => <button role="menuitem" key={item.id} disabled={busy}
              onClick={() => void run('open', item.id)}>{item.label}</button>)}
        </div>}
    </div>, document.body)}
  </>
}
