import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Button from './Button'
import Icon from './Icon'
import { fsApi, type DirectoryBrowseResult, type DirectoryOpener, type Project } from '../api/client'
import { type TFunction } from '../i18n'
import ProjectDirectoryBrowserDialog from './ProjectDirectoryBrowserDialog'
import { usesWebDirectoryBrowser } from '../utils/openLocation'

/*
 * OpenLocationButton — the "⌂ 打开目录" segmented control (main button + opener
 * dropdown) that reveals the active project directory in a chosen app.
 *
 * This is the single source of truth for the directory-opener UI. It is used by
 * the task board, chat page, and Git workspaces. All state (available openers,
 * selected opener, dropdown open, transient notice) and logic (fetch openers,
 * open directory) live here so the placements stay in sync.
 */

const OPENERS_STORAGE_KEY = 'workstep-directory-opener'

const FALLBACK_OPENERS: DirectoryOpener[] = [
  { id: 'file_manager', label: 'file_manager', available: true },
]

function OpenerIcon({ id }: { id: string }) {
  const visual: Record<string, { text: string; bg: string; color: string }> = {
    vscode: { text: '⌁', bg: 'var(--accent-light)', color: '#168bd2' },
    sublime: { text: 'S', bg: '#333', color: '#ff9800' },
    file_manager: { text: '⌂', bg: 'var(--accent-light)', color: '#2684ff' },
    terminal: { text: '>_', bg: '#454545', color: 'var(--accent-fg)' },
    iterm: { text: '$', bg: '#3e2945', color: '#59e391' },
    intellij: { text: 'IJ', bg: '#ef476f', color: 'var(--accent-fg)' },
    pycharm: { text: 'PC', bg: '#32c787', color: 'var(--accent-fg)' },
  }
  const item = visual[id] || visual.file_manager
  return (
    <span style={{
      width: 20, height: 20, borderRadius: 5, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: item.bg, color: item.color, fontSize: id === 'terminal' ? 8 : 10,
      fontWeight: 700, lineHeight: 1,
    }}>
      {item.text}
    </span>
  )
}

export interface OpenLocationButtonProps {
  activeProject: Project | null
  t: TFunction
  /** Directory to open instead of the project root. */
  directoryPath?: string
  buttonLabel?: string
  /** Empty string allows browsing a Git worktree outside the project root. */
  browserProjectId?: string
  forceWebBrowser?: boolean
  browseDirectory?: (path: string, includeHidden: boolean) => Promise<DirectoryBrowseResult>
  readOnlyBrowser?: boolean
  /**
   * Render the transient success/failure notice inline (just before the
   * buttons). Defaults to true. Set false when the parent renders the notice
   * elsewhere via `onNoticeChange`.
   */
  showInlineNotice?: boolean
  /**
   * Optional callback receiving the transient notice text (empty string clears
   * it). Lets a parent surface the notice at a custom position.
   */
  onNoticeChange?: (notice: string) => void
  /** Extra styles merged onto the main button. */
  mainButtonStyle?: CSSProperties
  /** Extra styles merged onto the chevron (opener-picker) button. */
  chevronButtonStyle?: CSSProperties
}

const MAIN_BUTTON_BASE: CSSProperties = {
  fontSize: 'calc(13px * var(--font-scale))', gap: 6,
  borderTopRightRadius: 0, borderBottomRightRadius: 0, paddingRight: 10,
}
const CHEVRON_BUTTON_BASE: CSSProperties = {
  width: 30, padding: 0, justifyContent: 'center',
  borderLeft: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
}
const NOTICE_BASE: CSSProperties = {
  maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', color: 'var(--meta)',
  fontSize: 'calc(13px * var(--font-scale))',
}
const MENU_BASE: CSSProperties = {
  position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 1200,
  width: 230, padding: 8, background: 'var(--bg)',
  border: '1px solid var(--border)', borderRadius: 14,
  boxShadow: '0 14px 36px rgba(0,0,0,0.16)',
}
const MENU_ITEM_BASE: CSSProperties = {
  width: '100%', height: 40, padding: '0 10px', gap: 10,
  justifyContent: 'flex-start', borderRadius: 9,
  color: 'var(--fg)', fontSize: 'calc(13px * var(--font-scale))',
}

export default function OpenLocationButton({
  activeProject,
  t,
  directoryPath,
  buttonLabel,
  browserProjectId,
  forceWebBrowser = false,
  browseDirectory,
  readOnlyBrowser = false,
  showInlineNotice = true,
  onNoticeChange,
  mainButtonStyle,
  chevronButtonStyle,
}: OpenLocationButtonProps) {
  const [directoryNotice, setDirectoryNotice] = useState('')
  const [directoryOpeners, setDirectoryOpeners] = useState<DirectoryOpener[]>(FALLBACK_OPENERS)
  const [selectedOpener, setSelectedOpener] = useState(
    () => (typeof localStorage !== 'undefined'
      ? (localStorage.getItem(OPENERS_STORAGE_KEY) || 'file_manager')
      : 'file_manager'),
  )
  const [showOpenerMenu, setShowOpenerMenu] = useState(false)
  const [showWebBrowser, setShowWebBrowser] = useState(false)
  const openerMenuRef = useRef<HTMLDivElement>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const onNoticeChangeRef = useRef(onNoticeChange)
  onNoticeChangeRef.current = onNoticeChange

  const openerDisplayLabel = (opener: DirectoryOpener) =>
    opener.id === 'file_manager' ? t('taskList.openLocation') : opener.label
  const targetPath = directoryPath || activeProject?.path

  const webDirectoryMode = forceWebBrowser || (activeProject ? usesWebDirectoryBrowser(
    activeProject.type,
    typeof window === 'undefined' ? 'localhost' : window.location.hostname,
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
    typeof window !== 'undefined' && Boolean(window.workstepDesktop?.directories),
  ) : false)

  // Load the platform's available directory openers.
  useEffect(() => {
    if (webDirectoryMode) return
    (window.workstepDesktop?.directories?.openers() ?? fsApi.directoryOpeners())
      .then(({ openers }) => {
        const available = openers.filter((opener) => opener.available)
        setDirectoryOpeners(available.length ? available : FALLBACK_OPENERS)
        if (!available.some((opener) => opener.id === selectedOpener)) {
          setSelectedOpener('file_manager')
          try { localStorage.setItem(OPENERS_STORAGE_KEY, 'file_manager') } catch { /* ignore */ }
        }
      })
      .catch(() => setDirectoryOpeners(FALLBACK_OPENERS))
  }, [selectedOpener, webDirectoryMode])

  // Close the opener menu on outside click / Escape.
  useEffect(() => {
    if (!showOpenerMenu) return
    const closeMenu = (event: MouseEvent) => {
      if (!openerMenuRef.current?.contains(event.target as Node)) setShowOpenerMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowOpenerMenu(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [showOpenerMenu])

  // Mirror the transient notice to the parent callback.
  useEffect(() => {
    onNoticeChangeRef.current?.(directoryNotice)
  }, [directoryNotice])

  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
  }, [])

  const setNotice = (notice: string) => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    setDirectoryNotice(notice)
    if (notice) {
      noticeTimerRef.current = window.setTimeout(() => setDirectoryNotice(''), 3000)
    }
  }

  const openProjectDirectory = async (openerId = selectedOpener) => {
    if (!activeProject || !targetPath) return
    if (webDirectoryMode) {
      setShowWebBrowser(true)
      return
    }
    try {
      const result = await (window.workstepDesktop?.directories?.open(targetPath, openerId) ?? fsApi.openDirectory(targetPath, openerId))
      setNotice(t('taskList.opened', { path: result.path }))
    } catch (error) {
      setNotice(t('taskList.openFailed', {
        error: error instanceof Error ? error.message : t('common.unknownError'),
      }))
    }
  }

  const selectDirectoryOpener = (opener: DirectoryOpener) => {
    setSelectedOpener(opener.id)
    try { localStorage.setItem(OPENERS_STORAGE_KEY, opener.id) } catch { /* ignore */ }
    setShowOpenerMenu(false)
    void openProjectDirectory(opener.id)
  }

  const disabled = !activeProject || !targetPath
  const selectedOpenerEntry = directoryOpeners.find((item) => item.id === selectedOpener)
    ?? { id: 'file_manager', label: '', available: true }

  return (
    <>
      {showInlineNotice && directoryNotice && (
        <span role="status" style={NOTICE_BASE} title={directoryNotice}>
          {directoryNotice}
        </span>
      )}
      <div ref={openerMenuRef} style={{ display: 'flex', position: 'relative' }}>
        <Button
          variant="ghost"
          onClick={() => void openProjectDirectory()}
          disabled={disabled}
          aria-label={buttonLabel || t('taskList.openLocation')}
          title={activeProject
            ? webDirectoryMode
              ? t('taskList.browseProjectTitle', { name: activeProject.name })
              : t('taskList.openWithTitle', {
                  opener: openerDisplayLabel(selectedOpenerEntry),
                  path: targetPath || '',
                })
            : t('taskList.selectProjectFirst')}
          style={{
            ...MAIN_BUTTON_BASE,
            ...(webDirectoryMode ? { borderRadius: 'var(--radius-sm)', paddingRight: 12 } : null),
            ...mainButtonStyle,
          }}
        >
          <OpenerIcon id={webDirectoryMode ? 'file_manager' : selectedOpener} />
          <span className="open-location-label">{buttonLabel || t('taskList.openLocation')}</span>
        </Button>
        {!webDirectoryMode && (
          <Button
            variant="ghost"
            aria-label={t('taskList.chooseOpener')}
            aria-expanded={showOpenerMenu}
            onClick={() => setShowOpenerMenu((value) => !value)}
            disabled={disabled}
            style={{ ...CHEVRON_BUTTON_BASE, ...chevronButtonStyle }}
          >
            <Icon name="chevron-down" size={13} strokeWidth={2.2} />
          </Button>
        )}
        {!webDirectoryMode && showOpenerMenu && (
          <div role="menu" aria-label={t('taskList.openerMenuAria')} style={MENU_BASE}>
            {directoryOpeners.map((opener) => (
              <button
                key={opener.id}
                className="open-location-menu-item"
                role="menuitem"
                onClick={() => selectDirectoryOpener(opener)}
                style={{
                  ...MENU_ITEM_BASE,
                  background: opener.id === selectedOpener ? 'var(--surface)' : 'transparent',
                }}
              >
                <OpenerIcon id={opener.id} />
                {openerDisplayLabel(opener)}
                {opener.id === selectedOpener && (
                  <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {showWebBrowser && activeProject && (
        <ProjectDirectoryBrowserDialog
          projectId={browserProjectId ?? activeProject.id}
          title={activeProject.name}
          rootPath={directoryPath}
          displayPath={directoryPath || t('browser.projectRoot')}
          browseDirectory={browseDirectory}
          readOnly={readOnlyBrowser}
          onClose={() => setShowWebBrowser(false)}
        />
      )}
    </>
  )
}
