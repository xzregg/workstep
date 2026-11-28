import { useI18n, type TKey } from '../i18n'
import type { ConnectionSnapshot } from './connectionDiagnostics'
import { diagnosticItems, translatedDiagnosticLabels } from './diagnosticPresentation'
import './WebRtcConnectionTimings.css'

export function WebRtcDiagnostics({ snapshot, failed }: { snapshot: ConnectionSnapshot; failed: boolean }) {
  const { t } = useI18n()
  const labels = translatedDiagnosticLabels(key => t(key as TKey))
  return <details className="webrtc-diagnostics" open={failed || undefined}>
    <summary>{labels.title}</summary>
    <dl>{diagnosticItems(snapshot, labels).map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
  </details>
}
