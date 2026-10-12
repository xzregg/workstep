import { useMemo, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { relativeMessageFilePath } from '../../utils/messageFileChanges'
import Icon from '../Icon'
import './GitDiffFileTree.css'

type TreeNode = { name: string; key: string; path?: string; children: TreeNode[] }

function fileTree(files: string[], projectRoot?: string): TreeNode[] {
  const roots: TreeNode[] = []
  for (const path of new Set(files)) {
    const parts = relativeMessageFilePath(path, projectRoot).replace(/\\/g, '/').split('/').filter(Boolean)
    let children = roots
    parts.forEach((name, index) => {
      const leaf = index === parts.length - 1
      const key = parts.slice(0, index + 1).join('/')
      let node = children.find(item => item.key === key && Boolean(item.path) === leaf)
      if (!node) { node = { name, key, children: [], ...(leaf ? { path } : {}) }; children.push(node) }
      children = node.children
    })
  }
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
  const merge = (nodes: TreeNode[]): TreeNode[] => nodes.map(node => {
    let current = node
    let name = node.name
    while (!current.path && current.children.length === 1 && !current.children[0].path) {
      current = current.children[0]
      name += `/${current.name}`
    }
    return { ...current, name, children: merge(current.children) }
  }).sort((a, b) => Number(Boolean(a.path)) - Number(Boolean(b.path)) || collator.compare(a.name, b.name))
  return merge(roots)
}

export default function GitDiffFileTree({ files, path, projectRoot, disabled = false, onSelect }: {
  files: string[]; path: string; projectRoot?: string; disabled?: boolean; onSelect: (path: string) => void
}) {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => fileTree(files, projectRoot), [files, projectRoot])
  const query = search.trim().toLocaleLowerCase()
  const filtered = useMemo(() => {
    const filter = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap(node => {
      if (node.path) return node.name.toLocaleLowerCase().includes(query) ? [node] : []
      const children = filter(node.children)
      return children.length ? [{ ...node, children }] : []
    })
    return query ? filter(tree) : tree
  }, [tree, query])
  const folders = useMemo(() => {
    const keys: string[] = []
    const visit = (nodes: TreeNode[]) => nodes.forEach(node => { if (!node.path) { keys.push(node.key); visit(node.children) } })
    visit(tree)
    return keys
  }, [tree])
  const render = (nodes: TreeNode[]): ReactNode => nodes.map(node => {
    const open = Boolean(query) || !collapsed.has(node.key)
    return <li key={node.key} role="none">
      <button type="button" role="treeitem" className="git-diff-tree-entry" title={node.key}
        aria-expanded={node.path ? undefined : open} aria-selected={node.path ? node.path === path : undefined}
        disabled={Boolean(node.path && disabled)} onClick={() => {
          if (node.path) onSelect(node.path)
          else setCollapsed(current => {
            const next = new Set(current)
            if (next.has(node.key)) next.delete(node.key); else next.add(node.key)
            return next
          })
        }}>
        <Icon name={node.path ? 'file' : open ? 'chevron-down' : 'chevron-right'} size={14} />
        {!node.path && <Icon name="folder" size={14} />}
        <span>{node.name}</span>
      </button>
      {!node.path && open && <ul role="group">{render(node.children)}</ul>}
    </li>
  })
  return <aside className="git-diff-file-tree" aria-label={t('browser.projectFiles')}>
    <div className="git-diff-tree-toolbar">
      <strong>{t('artifact.file')} <small>{files.length}</small></strong>
      <button type="button" aria-label={t('git.expandAll')} title={t('git.expandAll')} disabled={!folders.length}
        onClick={() => setCollapsed(new Set())}><Icon name="maximize-2" size={14} /></button>
      <button type="button" aria-label={t('browser.collapseAll')} title={t('browser.collapseAll')} disabled={!folders.length || Boolean(query)}
        onClick={() => setCollapsed(new Set(folders))}><Icon name="minimize-2" size={14} /></button>
    </div>
    <label className="git-diff-tree-search"><Icon name="search" size={14} /><input type="search" value={search}
      aria-label={t('browser.searchFiles')} placeholder={t('browser.searchFiles')} onChange={event => setSearch(event.target.value)} /></label>
    <ul className="git-diff-tree-list" role="tree" aria-label={t('browser.projectTree')}>{render(filtered)}</ul>
    {!filtered.length && <p className="git-diff-tree-empty">{t('browser.noSearchResults')}</p>}
  </aside>
}
