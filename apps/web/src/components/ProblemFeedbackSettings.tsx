import { useI18n } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import Button from './Button'
import { buildBrowserFeedback } from '../utils/browserDiagnostics'
import { copyText } from '../utils/clipboard'
import { redactDiagnosticText } from '../../../desktop/src/diagnostic-privacy.mjs'
import './ProblemFeedbackSettings.css'

export default function ProblemFeedbackSettings() {
  const { t } = useI18n()
  const bridge = typeof window !== 'undefined' ? window.workstepDesktop?.feedback : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState('')
  const [copied, setCopied] = useState(false)
  const reportRef = useRef<HTMLTextAreaElement>(null)
  const pending = useRef(false)
  useEffect(() => {
    if (error && report) { reportRef.current?.focus(); reportRef.current?.select() }
  }, [error, report])
  const open = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      if (bridge) await bridge.open()
      else {
        const text = buildBrowserFeedback()
        setReport(text)
        if (await copyText(text)) setCopied(true)
        else setError(t('settings.feedbackCopyFailed'))
      }
    }
    catch (error) { setError(redactDiagnosticText(error instanceof Error ? error.message : String(error))) }
    finally { pending.current = false; setBusy(false) }
  }
  return (
    <div className="settings-system-page">
      <h1 className="settings-system-title">{t('settings.problemFeedback')}</h1>
      <p className="settings-system-description">{t('settings.problemFeedbackIntro')}</p>
      <div className="settings-system-group problem-feedback">
        <Button variant="primary" loading={busy} onClick={() => void open()}>{t('settings.oneClickFeedback')}</Button>
        <p className="settings-system-description">{t(bridge ? 'settings.oneClickFeedbackIntro' : 'settings.browserFeedbackIntro')}</p>
        <p className="settings-system-description">{t('settings.feedbackPrivacyHint')}</p>
        {copied && <p role="status" className="settings-system-feedback settings-system-feedback--success">{t('settings.feedbackCopied')}</p>}
        {error && <p role="alert" className="settings-system-feedback settings-system-feedback--error">{error}</p>}
        {report && <>
          <textarea ref={reportRef} className="problem-feedback-report" readOnly value={report} aria-label={t('settings.feedbackReport')} />
          <p className="settings-system-description">{t('settings.feedbackScreenshotHint')}</p>
        </>}
      </div>
      <a className="btn btn-ghost"
        href="https://github.com/xzregg/workstep/issues/new?template=bug_report.yml"
        target="_blank" rel="noopener noreferrer">
        {t('settings.feedbackGithub')}
      </a>
    </div>
  )
}
