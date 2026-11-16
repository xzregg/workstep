import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import { useOverlay } from '../hooks/useOverlay'
import { useCompactLayout } from '../hooks/useCompactLayout'
import ResizablePanel from './ResizablePanel'
import Button from './Button'
import Icon from './Icon'
import Spinner from './Spinner'

export default function ManualHelpDialog({ chapter, onClose }: { chapter: string; onClose: () => void }) {
  const { t, locale } = useI18n()
  const compact = useCompactLayout()
  const overlay = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const closeRef = useRef(onClose)
  const currentChapter = useRef(chapter)
  closeRef.current = onClose
  const close = useCallback(() => closeRef.current(), [])
  const source = useMemo(() => `/landing/?embed=1&lang=${encodeURIComponent(locale)}#docs/${encodeURIComponent(currentChapter.current)}`, [locale])
  useOverlay(true, close, overlay, compact)
  useEffect(() => {
    setStatus('loading')
    const timer = window.setTimeout(() => setStatus('error'), 12000)
    const message = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
      if (event.data?.type === 'workstep:manual-ready') {
        if (typeof event.data.chapterId === 'string' && /^[a-z0-9-]{1,128}$/.test(event.data.chapterId)) currentChapter.current = event.data.chapterId
        window.clearTimeout(timer)
        setStatus('ready')
      }
      if (event.data?.type === 'workstep:manual-close') close()
    }
    window.addEventListener('message', message)
    return () => { window.clearTimeout(timer); window.removeEventListener('message', message) }
  }, [source, attempt, close])
  return createPortal(<div ref={overlay} className="modal-overlay manual-help-overlay" role="dialog"
    aria-modal="true" aria-label={t('manualHelp.title')}
    onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <ResizablePanel className="modal manual-help-dialog" minWidth={480} minHeight={320}>
      <div className="modal-header manual-help-header">
        <span className="modal-title"><Icon name="book" size={16} />{t('manualHelp.title')}</span>
        <div className="manual-help-actions">
        <Button type="button" variant="icon" className="manual-help-browser"
          title={t('manualHelp.openBrowser')} aria-label={t('manualHelp.openBrowser')}
          onClick={() => window.open(`/landing/?lang=${encodeURIComponent(locale)}#docs/${encodeURIComponent(currentChapter.current)}`, '_blank', 'noopener,noreferrer')}>
          <Icon name="external-link" size={16} />
        </Button>
        <Button type="button" variant="icon" className="manual-help-close" onClick={close}
          aria-label={t('common.close')}><Icon name="x" size={16} /></Button>
        </div>
      </div>
      <div className="manual-help-body">
        {status !== 'ready' && <div className="manual-help-state" role="status">
          {status === 'loading' ? <><Spinner size={16} /><span>{t('common.loading')}</span></>
            : <><p>{t('manualHelp.unavailable')}</p><Button onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</Button></>}
        </div>}
        <iframe key={`${source}:${attempt}`} ref={frame} className="manual-help-frame" src={source}
          title={t('manualHelp.title')} tabIndex={0} hidden={status === 'error'}
          onError={() => setStatus('error')} />
      </div>
    </ResizablePanel>
  </div>, document.body)
}
