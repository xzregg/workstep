import { classifyConnectionFailure, type ConnectionFailure, type ConnectionSnapshot } from './connectionDiagnostics'

export interface DiagnosticLabels {
  title: string; signal: string; local: string; remote: string; probes: string; ice: string; dtls: string; channel: string; stunErrors: string
  candidateCount: string; probeCount: string; unavailable: string
  states: Record<string, string>
  failures: Record<ConnectionFailure, string>
}
function format(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match)
}
export function diagnosticItems(snapshot: ConnectionSnapshot, labels: DiagnosticLabels): { label: string; value: string }[] {
  const state = (value: string) => labels.states[value] || value
  const counts = (value: ConnectionSnapshot['local']) => format(labels.candidateCount, { local: value.host, mapped: value.srflx + value.prflx })
  const items = [
    { label: labels.signal, value: `${snapshot.signalingUrl} · ${state(snapshot.socketState)}` },
    { label: labels.local, value: counts(snapshot.local) },
    { label: labels.remote, value: counts(snapshot.remote) },
    { label: labels.probes, value: snapshot.probes.pairs ? format(labels.probeCount, snapshot.probes) : labels.unavailable },
    { label: labels.ice, value: state(snapshot.iceState) },
    { label: labels.dtls, value: state(snapshot.dtlsState) },
    { label: labels.channel, value: state(snapshot.channelState) },
  ]
  if (snapshot.stunErrors.length) items.push({ label: labels.stunErrors, value: snapshot.stunErrors.map(item => `${item.server} (${item.code})`).join(' · ') })
  return items
}
export function connectionFailureMessage(snapshot: ConnectionSnapshot, original: string, labels: DiagnosticLabels): string {
  // Preserve explicit HTTP/auth/policy errors; only classify observed connection failures.
  if (!/timed out|WebSocket|DataChannel failed|hole-punching failed/i.test(original)) return original
  return labels.failures[classifyConnectionFailure(snapshot)]
}

export function translatedDiagnosticLabels(translate: (key: string) => string): DiagnosticLabels {
  const prefix = 'webrtcP2p.diagnostics.'
  const keys = ['title', 'signal', 'local', 'remote', 'probes', 'ice', 'dtls', 'channel', 'stunErrors', 'candidateCount', 'probeCount', 'unavailable']
  const states = ['new', 'connecting', 'checking', 'connected', 'completed', 'failed', 'closed', 'disconnected', 'open', 'closing']
  const failures: ConnectionFailure[] = ['configuration', 'pairing', 'signal_connect', 'signal_ready', 'signal_lost', 'answer', 'local_candidates', 'remote_candidates', 'ice_path', 'dtls', 'datachannel', 'authentication']
  return {
    ...Object.fromEntries(keys.map(key => [key, translate(prefix + key)])),
    states: Object.fromEntries(states.map(key => [key, translate(prefix + 'states.' + key)])),
    failures: Object.fromEntries(failures.map(key => [key, translate(prefix + 'failures.' + key)])),
  } as DiagnosticLabels
}
