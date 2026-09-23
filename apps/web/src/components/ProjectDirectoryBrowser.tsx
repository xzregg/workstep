import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { fsApi, type DirectoryBrowseResult, type DirectoryEntry } from '../api/client'
import { useI18n } from '../i18n'
import ArtifactPreview from './ArtifactPreview'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import ProjectDirectoryFileEditor from './ProjectDirectoryFileEditor'
import ProjectDirectoryTreeActions, { type BrowserActionTarget } from './ProjectDirectoryTreeActions'
import Spinner from './Spinner'

interface ProjectDirectoryBrowserProps {
  projectId: string
  rootPath?: string
  onDirtyChange?: (dirty: boolean) => void
}

interface SelectedFile {
  name: string
  path: string
}

function requestPath(entry: DirectoryEntry) {
  return entry.relative_path ?? entry.path
}

export default function ProjectDirectoryBrowser({
  projectId,
  rootPath,
  onDirtyChange,
}: ProjectDirectoryBrowserProps) {
  const { t } = useI18n()
  const [root, setRoot] = useState<DirectoryBrowseResult | null>(null)
  const [rootLoading, setRootLoading] = useState(true)
  const [rootError, setRootError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, DirectoryBrowseResult>>({})
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [pathErrors, setPathErrors] = useState<Record<string, string>>({})
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [expandingTwoLevels, setExpandingTwoLevels] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchResults, setSearchResults] = useState<DirectoryEntry[]>([])
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [treeWidth, setTreeWidth] = useState(30)
  const [resizing, setResizing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  const [editorRevision, setEditorRevision] = useState(0)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const [contextTarget, setContextTarget] = useState<BrowserActionTarget | null>(null)
  const [reloadRevision, setReloadRevision] = useState(0)
  const browserRef = useRef<HTMLDivElement>(null)
  const childrenRef = useRef<Record<string, DirectoryBrowseResult>>({})
  const directoryPromisesRef = useRef<Map<string, Promise<DirectoryBrowseResult | null>>>(new Map())
  const generationRef = useRef(0)
  const markEditorDirty = useCallback((dirty: boolean) => {
    setEditorDirty(dirty)
    onDirtyChange?.(dirty)
  }, [onDirtyChange])
  const beforeLeave = useCallback((action: () => void) => {
    if (editorDirty) setPendingLeave(() => action)
    else action()
  }, [editorDirty])
  const selectFile = useCallback((entry: DirectoryEntry) => {
    const path = requestPath(entry)
    if (selectedFile?.path === path) return
    beforeLeave(() => {
      markEditorDirty(false)
      setSelectedFile({ name: entry.name, path })
    })
  }, [beforeLeave, markEditorDirty, selectedFile?.path])

  useEffect(() => {
    setSearchQuery('')
  }, [projectId, rootPath])

  useEffect(() => {
    let active = true
    setRoot(null)
    setRootLoading(true)
    setRootError('')
    setExpanded(new Set())
    setChildren({})
    setLoadingPaths(new Set())
    setPathErrors({})
    setSelectedFile(null)
    setSearchResults([])
    setSearchError('')
    setSearchTruncated(false)
    childrenRef.current = {}
    directoryPromisesRef.current.clear()
    generationRef.current += 1
    fsApi.browse(rootPath, projectId, showHidden)
      .then((result) => {
        if (active) setRoot(result)
      })
      .catch((error) => {
        if (active) setRootError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (active) setRootLoading(false)
      })
    return () => { active = false }
  }, [projectId, rootPath, showHidden, reloadRevision])

  useEffect(() => {
    if (!resizing) return
    const resize = (event: PointerEvent) => {
      const bounds = browserRef.current?.getBoundingClientRect()
      if (!bounds?.width) return
      const next = ((event.clientX - bounds.left) / bounds.width) * 100
      setTreeWidth(Math.min(55, Math.max(20, next)))
    }
    const stop = () => setResizing(false)
    document.addEventListener('pointermove', resize)
    document.addEventListener('pointerup', stop)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('pointermove', resize)
      document.removeEventListener('pointerup', stop)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizing])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) {
      setSearchLoading(false)
      setSearchError('')
      setSearchResults([])
      setSearchTruncated(false)
      return
    }
    let active = true
    setSearchLoading(true)
    setSearchResults([])
    setSearchError('')
    setSearchTruncated(false)
    const timer = window.setTimeout(() => {
      fsApi.search(query, projectId, rootPath, showHidden)
        .then((result) => {
          if (!active) return
          setSearchResults(result.entries)
          setSearchTruncated(result.truncated)
        })
        .catch((error) => {
          if (active) setSearchError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (active) setSearchLoading(false)
        })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [projectId, rootPath, searchQuery, showHidden, reloadRevision])

  const loadDirectory = useCallback((entry: DirectoryEntry): Promise<DirectoryBrowseResult | null> => {
    const key = requestPath(entry)
    const cached = childrenRef.current[key]
    if (cached) return Promise.resolve(cached)
    const pending = directoryPromisesRef.current.get(key)
    if (pending) return pending
    const generation = generationRef.current
    setLoadingPaths((current) => new Set(current).add(key))
    setPathErrors((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    const promise = fsApi.browse(key, projectId, showHidden)
      .then((result) => {
        if (generation !== generationRef.current) return null
        childrenRef.current = { ...childrenRef.current, [key]: result }
        setChildren(childrenRef.current)
        return result
      })
      .catch((error) => {
        if (generation === generationRef.current) {
          setPathErrors((current) => ({
            ...current,
            [key]: error instanceof Error ? error.message : String(error),
          }))
        }
        return null
      })
      .finally(() => {
        if (directoryPromisesRef.current.get(key) === promise) {
          directoryPromisesRef.current.delete(key)
        }
        if (generation === generationRef.current) {
          setLoadingPaths((current) => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
        }
      })
    directoryPromisesRef.current.set(key, promise)
    return promise
  }, [projectId, showHidden])

  const toggleDirectory = useCallback((entry: DirectoryEntry) => {
    const key = requestPath(entry)
    const isExpanded = expanded.has(key)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (!isExpanded) void loadDirectory(entry)
  }, [expanded, loadDirectory])

  const expandTwoLevels = useCallback(async () => {
    if (!root || expandingTwoLevels) return
    setExpandingTwoLevels(true)
    const generation = generationRef.current
    const nextExpanded = new Set<string>()
    const visited = new Set<string>([root.path])
    const walk = async (entries: DirectoryEntry[], depth: number) => {
      const directories = entries.filter((entry) => entry.type === 'directory')
      directories.forEach((entry) => nextExpanded.add(requestPath(entry)))
      const listings = await Promise.all(directories.map((entry) => loadDirectory(entry)))
      if (depth >= 2) return
      await Promise.all(listings.map(async (listing) => {
        if (!listing || visited.has(listing.path)) return
        visited.add(listing.path)
        await walk(listing.entries, depth + 1)
      }))
    }
    try {
      await walk(root.entries, 1)
      if (generation === generationRef.current) setExpanded(nextExpanded)
    } finally {
      setExpandingTwoLevels(false)
    }
  }, [expandingTwoLevels, loadDirectory, root])

  const rootEntry = useMemo<DirectoryEntry | null>(() => root ? ({
    name: root.name,
    type: 'directory',
    path: root.path,
    relative_path: root.relative_path,
  }) : null, [root])

  const searchActive = searchQuery.trim().length > 0

  const renderEntries = (entries: DirectoryEntry[], depth: number, parentPath: string): ReactNode => entries.map((entry) => {
    const key = requestPath(entry)
    const isDirectory = entry.type === 'directory'
    const isExpanded = isDirectory && expanded.has(key)
    const listing = children[key]
    const selected = !isDirectory && selectedFile?.path === key
    return (
      <div key={`${entry.type}:${key}`}>
        <div
          className="project-directory-tree-item"
          role="treeitem"
          aria-expanded={isDirectory ? isExpanded : undefined}
          aria-selected={selected}
          tabIndex={0}
          data-selected={selected ? 'true' : undefined}
          style={{ paddingLeft: 8 + depth * 18 }}
          title={entry.path}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextTarget({ entry, parentPath, x: event.clientX, y: event.clientY })
          }}
          onClick={() => {
            if (isDirectory) toggleDirectory(entry)
            else selectFile(entry)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            if (isDirectory) toggleDirectory(entry)
            else selectFile(entry)
          }}
        >
          <span className="project-directory-tree-chevron" aria-hidden="true">
            {isDirectory ? (
              <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} strokeWidth={2} />
            ) : null}
          </span>
          <Icon
            name={isDirectory ? 'folder' : 'file'}
            size={15}
            color={isDirectory ? 'var(--accent)' : 'var(--muted)'}
          />
          <span className="project-directory-tree-name">{entry.name}</span>
          {loadingPaths.has(key) && <Spinner size={12} />}
        </div>
        {isExpanded && (
          <div role="group">
            {pathErrors[key] && (
              <div className="project-directory-tree-state" style={{ paddingLeft: 28 + depth * 18 }}>
                {pathErrors[key]}
              </div>
            )}
            {!pathErrors[key] && listing?.entries.length === 0 && (
              <div className="project-directory-tree-state" style={{ paddingLeft: 28 + depth * 18 }}>
                {t('browser.emptyDir')}
              </div>
            )}
            {listing ? renderEntries(listing.entries, depth + 1, listing.path) : null}
          </div>
        )}
      </div>
    )
  })

  return (
    <div
      ref={browserRef}
      className="project-directory-browser"
      style={{ '--directory-tree-width': `${treeWidth}%` } as CSSProperties}
    >
      <aside className="project-directory-tree-panel">
        <div className="project-directory-tree-heading">
          <span>{t('browser.projectFiles')}</span>
          <div className="project-directory-tree-actions">
            <button
              type="button"
              className="settings-switch"
              role="switch"
              aria-label={t('browser.showHidden')}
              title={t('browser.showHidden')}
              aria-checked={showHidden}
              onClick={() => beforeLeave(() => {
                markEditorDirty(false)
                setShowHidden((current) => !current)
              })}
              style={{ background: showHidden ? 'var(--accent)' : 'var(--border)' }}
            >
              <span className="settings-switch-thumb" />
            </button>
            <Button
              variant="icon"
              aria-label={t('browser.expandTwoLevels')}
              title={t('browser.expandTwoLevels')}
              disabled={!root || rootLoading || expandingTwoLevels}
              loading={expandingTwoLevels}
              onClick={() => void expandTwoLevels()}
              style={{ width: 26, height: 26, minWidth: 26, padding: 0 }}
            >
              <Icon name="maximize-2" size={13} />
            </Button>
            <Button
              variant="icon"
              aria-label={t('browser.collapseAll')}
              title={t('browser.collapseAll')}
              disabled={expanded.size === 0}
              onClick={() => setExpanded(new Set())}
              style={{ width: 26, height: 26, minWidth: 26, padding: 0 }}
            >
              <Icon name="minimize-2" size={13} />
            </Button>
          </div>
        </div>
        <label className="project-directory-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={searchQuery}
            placeholder={t('browser.searchFiles')}
            aria-label={t('browser.searchFiles')}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchLoading && <Spinner size={12} />}
        </label>
        <div
          className="project-directory-tree"
          role="tree"
          aria-label={t('browser.projectTree')}
          onContextMenu={(event) => {
            if (!rootEntry || (event.target as Element).closest('[role="treeitem"]')) return
            event.preventDefault()
            setContextTarget({ entry: rootEntry, parentPath: rootEntry.path, x: event.clientX, y: event.clientY, isRoot: true })
          }}
        >
          {rootLoading && (
            <div className="project-directory-browser-state"><Spinner size={14} /> {t('common.loading')}</div>
          )}
          {!rootLoading && rootError && (
            <div className="project-directory-browser-state project-directory-browser-error">
              {t('artifact.loadFailed', { error: rootError })}
            </div>
          )}
          {!rootLoading && searchActive && searchError && (
            <div className="project-directory-browser-state project-directory-browser-error">
              {t('artifact.loadFailed', { error: searchError })}
            </div>
          )}
          {!rootLoading && searchActive && !searchLoading && !searchError && searchResults.length === 0 && (
            <div className="project-directory-browser-state">{t('browser.noSearchResults')}</div>
          )}
          {!rootLoading && searchActive && !searchError && searchResults.map((entry) => (
            <div
              key={entry.relative_path ?? entry.path}
              className="project-directory-tree-item project-directory-search-result"
              role="treeitem"
              tabIndex={0}
              data-search-result="true"
              data-selected={selectedFile?.path === requestPath(entry) ? 'true' : undefined}
              title={entry.path}
              onClick={() => selectFile(entry)}
              onContextMenu={(event) => {
                event.preventDefault()
                setContextTarget({ entry, parentPath: entry.path.replace(/[\\/][^\\/]+$/, ''), x: event.clientX, y: event.clientY })
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                selectFile(entry)
              }}
            >
              <span className="project-directory-tree-chevron" aria-hidden="true" />
              <Icon name="file" size={15} color="var(--muted)" />
              <span className="project-directory-search-result-label">
                <strong>{entry.name}</strong>
                <small>{entry.relative_path ?? entry.path}</small>
              </span>
            </div>
          ))}
          {!rootLoading && searchActive && searchTruncated && (
            <div className="project-directory-tree-state">{t('browser.searchTruncated')}</div>
          )}
          {!rootLoading && !searchActive && root && rootEntry && (
            <div>
              <div
                className="project-directory-tree-item project-directory-tree-root"
                role="treeitem"
                aria-expanded="true"
                tabIndex={0}
                title={root.path}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setContextTarget({ entry: rootEntry, parentPath: root.path, x: event.clientX, y: event.clientY, isRoot: true })
                }}
              >
                <span className="project-directory-tree-chevron" aria-hidden="true">
                  <Icon name="chevron-down" size={12} strokeWidth={2} />
                </span>
                <Icon name="folder" size={15} color="var(--accent)" />
                <span className="project-directory-tree-name">{rootEntry.name}</span>
              </div>
              <div role="group">
                {root.entries.length > 0 ? renderEntries(root.entries, 1, root.path) : (
                  <div className="project-directory-tree-state" style={{ paddingLeft: 46 }}>
                    {t('browser.emptyDir')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>
      <div
        className="project-directory-resizer"
        role="separator"
        aria-label={t('browser.resizeTree')}
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={55}
        aria-valuenow={Math.round(treeWidth)}
        tabIndex={0}
        data-resizing={resizing ? 'true' : undefined}
        onPointerDown={(event) => {
          event.preventDefault()
          setResizing(true)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          setTreeWidth((current) => Math.min(55, Math.max(20, current + (event.key === 'ArrowRight' ? 3 : -3))))
        }}
      />
      <section className="project-directory-preview" aria-label={t('browser.filePreview')}>
        <div className="project-directory-preview-content">
          {selectedFile ? editing ? (
            <ProjectDirectoryFileEditor
              key={`${selectedFile.path}:${editorRevision}`}
              path={selectedFile.path}
              name={selectedFile.name}
              projectId={projectId}
              rootPath={rootPath}
              onDirtyChange={markEditorDirty}
              onPreview={() => beforeLeave(() => setEditing(false))}
            />
          ) : (
            <ArtifactPreview key={selectedFile.path} path={selectedFile.path} name={selectedFile.name} projectId={projectId} onEdit={() => setEditing(true)} />
          ) : (
            <div className="project-directory-preview-empty">
              <Icon name="file" size={28} strokeWidth={1.4} />
              <span>{t('browser.selectFile')}</span>
            </div>
          )}
        </div>
      </section>
      <ProjectDirectoryTreeActions
        projectId={projectId}
        rootPath={rootPath}
        target={contextTarget}
        onDismiss={() => setContextTarget(null)}
        onPreview={(entry) => {
          markEditorDirty(false)
          setEditing(false)
          setSelectedFile({ name: entry.name, path: requestPath(entry) })
        }}
        onBeforeAction={beforeLeave}
        onChanged={() => {
          markEditorDirty(false)
          setSelectedFile(null)
          setReloadRevision((current) => current + 1)
        }}
      />
      {createPortal(<ConfirmDialog
        open={pendingLeave !== null}
        title={t('browser.unsavedTitle')}
        message={t('browser.unsavedMessage')}
        confirmText={t('browser.discardChanges')}
        danger
        zIndex={2400}
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => {
          const action = pendingLeave
          setPendingLeave(null)
          markEditorDirty(false)
          setEditorRevision((current) => current + 1)
          action?.()
        }}
      />, document.body)}
    </div>
  )
}
