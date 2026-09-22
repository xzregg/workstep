import { useEffect, useState } from 'react'
import { gitApi, type GitCommit } from '../../api/git'
import { useI18n } from '../../i18n'
import Button from '../Button'

export default function GitHistory({ id, branch, head, onCommit }: { id: string; branch?: string; head?: string | null; onCommit: (hash: string) => void }) {
  const { t } = useI18n()
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    gitApi.history(id, branch).then(r => { if (current) { setCommits(r.commits); setMore(r.has_more) } }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [id, branch, head])
  async function next() {
    setLoading(true)
    try { const r = await gitApi.history(id, branch, commits.length); setCommits(c => [...c, ...r.commits]); setMore(r.has_more); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  return <div className="git-history">{commits.map(c => <button key={c.hash} onClick={() => onCommit(c.hash)}><span className="git-history-dot" /><span><strong>{c.message}</strong><small>{c.author} · {new Date(c.time * 1000).toLocaleString()}</small></span><code>{c.hash.slice(0, 8)}</code></button>)}{error && <p role="alert" className="git-danger">{error}</p>}{!commits.length && !loading && !error && <p>{t('git.historyEmpty')}</p>}{(more || loading || error) && <Button loading={loading} onClick={() => void next()}>{error ? t('git.retry') : t('git.more')}</Button>}</div>
}
