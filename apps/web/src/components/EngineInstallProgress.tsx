import Spinner from './Spinner'
import './EngineInstallProgress.css'

/** Package managers do not expose a shared progress metric; only completion is confirmed. */
export default function EngineInstallProgress({ active, completed = false, label }: {
  active: boolean
  completed?: boolean
  label: string
}) {
  const { t } = useI18n()
  const [estimate, setEstimate] = useState(0)
  useEffect(() => {
    setEstimate(0)
    if (!active || completed) return
    const timer = setInterval(() => {
      setEstimate((current) => Math.min(95, current + Math.max(1, Math.ceil((95 - current) / 20))))
    }, 2000)
    return () => clearInterval(timer)
  }, [active, completed])
  if (!active && !completed) return null
  const percentage = completed ? 100 : estimate
  const progressLabel = completed ? t('settings.installComplete') : label
  const valueText = completed ? '100%' : t('settings.installEstimatedProgress', { percent: percentage })

  return (
    <div className="engine-install-progress">
      <div className="engine-install-progress-label" role="status">
        {!completed && <Spinner />}
        <span>{progressLabel}</span>
        <span className="engine-install-progress-value" aria-live="off">{valueText}</span>
      </div>
      <div className="engine-install-progress-track" role="progressbar" aria-label={progressLabel}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={valueText}>
        <span className="engine-install-progress-fill" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  )
}
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
