import ResizablePanel from './ResizablePanel'
import { useEffect, useMemo, useState, useRef } from 'react'
import Button from './Button'
import Input from './Input'
import Icon from './Icon'
import ConfirmDialog from './ConfirmDialog'
import SegmentedControl from './SegmentedControl'
import { taskApi, type ShareInfo } from '../api/client'
import { useI18n } from '../i18n'
import { copyText } from '../utils/clipboard'
import { useProjectStore } from '../stores/projectStore'
import { taskShareUrl } from '../utils/taskShareUrl'

type ShareMode = 'read_only' | 'interactive'

interface Props {
  open: boolean
  taskId: string
  projectId: string
  onClose: () => void
  onChanged?: (share: ShareInfo | null) => void
  api?: {
    get: (taskId: string, projectId: string) => Promise<ShareInfo | null>
    create: (taskId: string, projectId: string, password: string | null, title: string | null, mode: ShareMode, expiresAt?: string | null) => Promise<ShareInfo>
    revoke: (taskId: string, projectId: string) => Promise<unknown>
  }
  gateway?: boolean
}

/** Share-dialog: create, view, copy, and revoke a task's share link. */
export default function ShareDialog({
  open,
  taskId,
  projectId,
  onClose,
  onChanged,
  api = taskApi.share,
  gateway = false,
}: Props) {
  const { t } = useI18n()
  const project = useProjectStore(state => state.projects.find(item => item.id === projectId))
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [copied, setCopied] = useState(false)
  const [password, setPassword] = useState('')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<ShareMode>('read_only')
  const [expiresAt, setExpiresAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const pending = useRef(false)

  // Reset transient state whenever the dialog (re)opens.
  useEffect(() => {
    if (!open) return
    setPassword('')
    setTitle('')
    setMode('read_only')
    setExpiresAt('')
    setError(null)
    setCopied(false)
    setConfirmRevoke(false)
    setConfirmClose(false)
    setLoading(true)
    let cancelled = false
    api
      .get(taskId, projectId)
      .then((info) => {
        if (!cancelled) setShare(info)
      })
      .catch((err: Error) => {
        if (!cancelled) {
          // 404 means no share yet — that's normal.
          if (!/404|no active share/i.test(err.message)) {
            setError(err.message)
          }
          setShare(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, taskId, projectId, api])

  const shareUrl = useMemo(() => {
    if (!share) return ''
    if (gateway) return share.url || ''
    return taskShareUrl(share.token, project, window.location.origin)
  }, [share, project, gateway])

  if (!open) return null

  const requestClose = () => {
    if (pending.current) return
    if (!share && (password || title || expiresAt || mode !== 'read_only')) setConfirmClose(true)
    else onClose()
  }

  const handleCreate = async () => {
    if (pending.current || loading) return
    if (password.length > 0 && password.length < 4) {
      setError(t('share.passwordTooShort'))
      return
    }
    setError(null)
    pending.current = true
    setCreating(true)
    try {
      const created = await api.create(
        taskId,
        projectId,
        password || null,
        title.trim() || null,
        mode,
        expiresAt ? new Date(expiresAt).toISOString() : null,
      )
      setShare(created)
      setPassword('')
      setTitle('')
      setMode('read_only')
      onChanged?.(created)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(t('share.createFailed', { error: message }))
    } finally {
      pending.current = false
      setCreating(false)
    }
  }

  const handleCopy = async () => {
    const ok = await copyText(shareUrl)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  const handleOpenWindow = () => {
    if (!shareUrl) return
    window.open(shareUrl, '_blank', 'noopener,noreferrer')
  }

  const handleRevoke = async () => {
    if (pending.current) return
    pending.current = true
    setRevoking(true)
    try {
      await api.revoke(taskId, projectId)
      setShare(null)
      setConfirmRevoke(false)
      onChanged?.(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(t('share.revokeFailed', { error: message }))
    } finally {
      pending.current = false
      setRevoking(false)
    }
  }

  return (
    <>
      <div
        onClick={requestClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2000,
          background: 'color-mix(in srgb, var(--fg) 35%, transparent)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ResizablePanel
          role="dialog" aria-modal="true" aria-label={t('share.dialogTitle')}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: 'var(--bg)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--elev-raised), 0 0 0 1px var(--border-soft)',
            width: 460,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 64px)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div data-dialog-drag-handle style={{ padding: '18px 20px 0' }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8,
            }}>
              <div style={{
                fontSize: 'calc(14px * var(--font-scale))', fontWeight: 600, fontFamily: 'var(--font-display)', color: 'var(--fg)',
              }}>
                {t('share.dialogTitle')}
              </div>
              <Button variant="icon" onClick={requestClose} aria-label={t('common.close')}>
                <Icon name="x" size={16} />
              </Button>
            </div>
            <div style={{
              fontSize: 'calc(12px * var(--font-scale))', color: 'var(--muted)', marginTop: 6, lineHeight: 1.5,
            }}>
              {t('share.dialogSubtitle')}
            </div>
          </div>

          {/* Body */}
          <div style={{ padding: '16px 20px 20px', overflow: 'auto' }}>
            {loading ? (
              <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)', padding: '8px 0' }}>
                {t('common.loading')}
              </div>
            ) : share ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {t('share.currentLink')}
                </div>
                {!shareUrl && <div className="task-share-link-unavailable">
                  <p>{t('share.savedLinkUnavailable')}</p>
                  <Button onClick={() => setShare(null)}>{t('share.create')}</Button>
                </div>}
                {shareUrl && <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-soft, color-mix(in oklab, var(--fg), transparent 95%))',
                  border: '1px solid var(--border-soft)',
                }}>
                  <input
                    readOnly
                    value={shareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    style={{
                      flex: 1, minWidth: 0, border: 0, background: 'transparent',
                      fontSize: 'calc(12px * var(--font-scale))', fontFamily: 'var(--font-mono)', color: 'var(--fg)',
                      outline: 'none',
                    }}
                  />
                  <Button variant="ghost" onClick={handleCopy} style={{ fontSize: 'calc(12px * var(--font-scale))', height: 28 }}>
                    <Icon name={copied ? 'check' : 'copy'} size={13} />
                    {copied ? t('share.linkCopied') : t('share.copyLink')}
                  </Button>
                  <Button variant="ghost" onClick={handleOpenWindow} style={{ fontSize: 'calc(12px * var(--font-scale))', height: 28 }}>
                    <Icon name="external-link" size={13} />
                    {t('share.openWindow')}
                  </Button>
                </div>}
                {share.title && (
                  <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--fg-2)' }}>{share.title}</div>
                )}
                <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--muted)' }}>
                  {t('share.createdAt', {
                    time: share.created_at ? new Date(share.created_at).toLocaleString() : '',
                  })}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                  <Button
                    variant="danger"
                    loading={revoking}
                    onClick={() => setConfirmRevoke(true)}
                    style={{ fontSize: 'calc(13px * var(--font-scale))' }}
                  >
                    <Icon name="trash" size={13} />
                    {t('share.revoke')}
                  </Button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)' }}>
                    {t('share.passwordLabel')} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({t('common.optional')})</span>
                  </span>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('share.passwordPlaceholder')}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !creating) handleCreate()
                    }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)' }}>
                    {t('share.titleLabel')}
                  </span>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('share.titlePlaceholder')}
                  />
                </label>
                {gateway && <label className="task-share-expiry">
                  <span>{t('share.expiresAtLabel')}</span>
                  <Input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} />
                </label>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)' }}>
                    {t('share.modeLabel')}
                  </span>
                  <SegmentedControl
                    ariaLabel={t('share.modeLabel')}
                    value={mode}
                    options={[
                      { value: 'read_only', label: t('share.modeReadOnly') },
                      { value: 'interactive', label: t('share.modeInteractive') },
                    ]}
                    onChange={setMode}
                    style={{ justifyContent: 'flex-start' }}
                  />
                  <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--muted)', lineHeight: 1.5 }}>
                    {mode === 'interactive'
                      ? t('share.modeInteractiveHint')
                      : t('share.modeReadOnlyHint')}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                  <Button
                    variant="primary"
                    loading={creating}
                    disabled={password.length > 0 && password.length < 4}
                    onClick={handleCreate}
                    style={{ fontSize: 'calc(13px * var(--font-scale))' }}
                  >
                    <Icon name="share" size={13} />
                    {t('share.create')}
                  </Button>
                </div>
              </div>
            )}

            {error && (
              <div style={{
                marginTop: 12, fontSize: 'calc(12px * var(--font-scale))', color: 'var(--danger)',
                padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                background: 'color-mix(in oklab, var(--danger), transparent 92%)',
                border: '1px solid color-mix(in oklab, var(--danger), transparent 80%)',
              }}>
                {error}
              </div>
            )}
          </div>
        </ResizablePanel>
      </div>

      <ConfirmDialog open={confirmClose} title={t('share.discardTitle')} message={t('share.discardMessage')}
        confirmText={t('share.discardConfirm')} zIndex={2100}
        onConfirm={() => { setConfirmClose(false); onClose() }} onCancel={() => setConfirmClose(false)} />
      <ConfirmDialog
        loading={revoking}
        open={confirmRevoke}
        title={t('share.revokeConfirmTitle')}
        message={t('share.revokeConfirmMessage')}
        danger
        confirmText={t('share.revoke')}
        onConfirm={handleRevoke}
        onCancel={() => setConfirmRevoke(false)}
      />
    </>
  )
}
