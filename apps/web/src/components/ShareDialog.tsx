import { useEffect, useMemo, useState } from 'react'
import Button from './Button'
import Input from './Input'
import Icon from './Icon'
import ConfirmDialog from './ConfirmDialog'
import SegmentedControl from './SegmentedControl'
import { taskApi, type ShareInfo } from '../api/client'
import { useI18n } from '../i18n'

type ShareMode = 'read_only' | 'interactive'

interface Props {
  open: boolean
  taskId: string
  projectId: string
  onClose: () => void
  onChanged?: (share: ShareInfo | null) => void
}

/** Share-dialog: create, view, copy, and revoke a task's share link. */
export default function ShareDialog({
  open,
  taskId,
  projectId,
  onClose,
  onChanged,
}: Props) {
  const { t } = useI18n()
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [copied, setCopied] = useState(false)
  const [password, setPassword] = useState('')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<ShareMode>('read_only')
  const [error, setError] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  // Reset transient state whenever the dialog (re)opens.
  useEffect(() => {
    if (!open) return
    setPassword('')
    setTitle('')
    setMode('read_only')
    setError(null)
    setCopied(false)
    setConfirmRevoke(false)
    setLoading(true)
    let cancelled = false
    taskApi.share
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
  }, [open, taskId, projectId])

  const shareUrl = useMemo(() => {
    if (!share) return ''
    return `${window.location.origin}/share/${encodeURIComponent(share.token)}`
  }, [share])

  if (!open) return null

  const handleCreate = async () => {
    if (password.length > 0 && password.length < 4) {
      setError(t('share.passwordTooShort'))
      return
    }
    setError(null)
    setCreating(true)
    try {
      const created = await taskApi.share.create(
        taskId,
        projectId,
        password || null,
        title.trim() || null,
        mode,
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
      setCreating(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback: select input text.
    }
  }

  const handleOpenWindow = () => {
    if (!shareUrl) return
    window.open(shareUrl, '_blank', 'noopener,noreferrer')
  }

  const handleRevoke = async () => {
    setRevoking(true)
    try {
      await taskApi.share.revoke(taskId, projectId)
      setShare(null)
      setConfirmRevoke(false)
      onChanged?.(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(t('share.revokeFailed', { error: message }))
    } finally {
      setRevoking(false)
    }
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2000,
          background: 'rgba(0,0,0,0.35)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
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
          <div style={{ padding: '18px 20px 0' }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8,
            }}>
              <div style={{
                fontSize: 'calc(14px * var(--font-scale))', fontWeight: 600, fontFamily: 'var(--font-display)', color: 'var(--fg)',
              }}>
                {t('share.dialogTitle')}
              </div>
              <Button variant="icon" onClick={onClose} aria-label={t('common.close')}>
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
                <div style={{
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
                </div>
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
        </div>
      </div>

      <ConfirmDialog
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
