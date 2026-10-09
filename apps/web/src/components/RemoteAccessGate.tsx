import AppLoading from './AppLoading'
import ResizablePanel from './ResizablePanel'
import { useEffect, useState, type ReactNode } from 'react'
import { remoteProjectApi } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import Input from './Input'

/**
 * Blocks the whole app for non-local visitors until they enter the remote
 * access password. Local (127.0.0.1 / localhost) visitors and installations
 * without a configured password pass straight through.
 */
export default function RemoteAccessGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [checked, setChecked] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    remoteProjectApi
      .accessStatus()
      .then((status) => {
        if (!active) return
        setUnlocked(!status.required || status.local || status.authorized)
      })
      .catch(() => {
        // If the check itself fails, keep the app usable; the server guard
        // still rejects protected API calls.
        if (active) setUnlocked(true)
      })
      .finally(() => {
        if (active) setChecked(true)
      })
    return () => {
      active = false
    }
  }, [])

  const submit = async () => {
    if (!draft.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await remoteProjectApi.unlock(draft)
      setDraft('')
      setUnlocked(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('remoteAccess.wrongPassword'))
    } finally {
      setSubmitting(false)
    }
  }

  if (!checked) return <AppLoading />
  if (unlocked) return <>{children}</>

  return (
    <div className="modal-overlay" style={{ zIndex: 4000 }}>
      <ResizablePanel
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-access-title"
        style={{ width: 420, maxWidth: 'calc(100vw - 32px)' }}
      >
        <div className="modal-header">
          <span id="remote-access-title" className="modal-title">{t('remoteAccess.title')}</span>
        </div>
        <div className="modal-body">
          <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>
            {t('remoteAccess.intro')}
          </p>
          <label className="field-label" htmlFor="remote-access-password">{t('remoteAccess.password')}</label>
          <Input
            id="remote-access-password"
            type="password"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim() && !submitting) void submit()
            }}
            placeholder={t('remoteAccess.passwordPlaceholder')}
            autoFocus
            maxLength={200}
          />
          {error && (
            <div role="status" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'calc(11px * var(--font-scale))' }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="primary" loading={submitting} disabled={!draft.trim()} onClick={() => void submit()}>
            {t('remoteAccess.unlock')}
          </Button>
        </div>
      </ResizablePanel>
    </div>
  )
}
