import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { WEBRTC_CONNECTION_STAGES, type WebRtcStageTiming } from './peerClient'
import './WebRtcConnectionTimings.css'

export function WebRtcConnectionTimings({ timings, startedAt, failed = false }: {
  timings: WebRtcStageTiming[]
  startedAt: number
  failed?: boolean
}) {
  const { t, locale } = useI18n()
  const [clock, setClock] = useState(() => performance.now())
  useEffect(() => {
    if (failed) return
    const timer = window.setInterval(() => setClock(performance.now()), 250)
    return () => window.clearInterval(timer)
  }, [startedAt, failed])
  const elapsed = new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', maximumFractionDigits: 1, minimumFractionDigits: 1 })
  const shortElapsed = new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', maximumFractionDigits: 0 })
  return (
    <ol className="webrtc-stage-list" aria-label={t('webrtcP2p.timings')}>
      {WEBRTC_CONNECTION_STAGES.map((stage) => {
        const timing = timings.find(item => item.stage === stage)
        const current = timings.at(-1)?.stage === stage
        const milliseconds = current && !failed ? Math.max(0, clock - startedAt) : timing?.durationMs
        return (
          <li key={stage} aria-current={current ? 'step' : undefined} data-failed={current && failed || undefined}
            data-pending={timing === undefined || undefined}>
            <span>{t(`webrtcP2p.steps.${stage}`)}</span>
            <span>{milliseconds === undefined ? <span aria-hidden="true">—</span>
              : milliseconds < 1000 ? shortElapsed.format(milliseconds) : elapsed.format(milliseconds / 1000)}</span>
          </li>
        )
      })}
    </ol>
  )
}
