import { setWakeEnabled, useWakeEnabled } from './wakePreferences'
import { primeSpeechOutput } from '../../utils/speechOutput'

export default function WakePreferenceSwitch({ label, className }: {
  label: string; className: string
}) {
  const enabled = useWakeEnabled()
  return <div className={`wake-enabled-switch ${className}`}>
    <span>{label}</span>
    <button type="button" className="settings-switch" role="switch" aria-label={label}
      aria-checked={enabled} onClick={() => {
        if (!enabled) primeSpeechOutput()
        setWakeEnabled(!enabled)
      }}><span className="settings-switch-thumb" /></button>
  </div>
}
