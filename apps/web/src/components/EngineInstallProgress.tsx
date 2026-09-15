import Spinner from './Spinner'
import './EngineInstallProgress.css'

export function formatPackageBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${Number(value.toFixed(1))} ${units[unit]}`
}

/** Only the archive download has a byte denominator; installation is indeterminate. */
export default function EngineInstallProgress({ active, completed = false, label, downloadedBytes, totalBytes }: {
  active: boolean
  completed?: boolean
  label: string
  downloadedBytes?: number
  totalBytes?: number | null
}) {
  if (!active && !completed) return null
  const measured = typeof totalBytes === 'number' && Number.isFinite(totalBytes) && totalBytes > 0
    && typeof downloadedBytes === 'number' && Number.isFinite(downloadedBytes)
  const percentage = completed ? 100 : measured
    ? Math.min(100, Math.max(0, Math.floor(downloadedBytes! / totalBytes! * 100))) : undefined
  const valueText = completed ? '100%' : downloadedBytes !== undefined
    ? `${formatPackageBytes(downloadedBytes)}${measured ? ` / ${formatPackageBytes(totalBytes!)} · ${percentage}%` : ''}` : ''
  return (
    <div className="engine-install-progress">
      <div className="engine-install-progress-label" role="status">
        {!completed && <Spinner />}
        <span>{label}</span>
        <span className="engine-install-progress-value" aria-live="off">{valueText}</span>
      </div>
      <div className="engine-install-progress-track" role="progressbar" aria-label={label}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={valueText || label}>
        <span className={`engine-install-progress-fill${percentage === undefined ? ' is-indeterminate' : ''}`}
          style={percentage === undefined ? undefined : { width: `${percentage}%` }} />
      </div>
    </div>
  )
}
