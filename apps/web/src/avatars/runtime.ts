export const AVATAR_STATE_EVENT = 'workstep:avatar-state'
export const AVATAR_AUDIO_EVENT = 'workstep:avatar-audio'
export interface AvatarScope { projectId: string; sessionId: string }
export type AvatarPhase = 'idle' | 'listening' | 'thinking' | 'working' | 'replying' | 'speaking'
export interface AvatarInput {
  phase: AvatarPhase
  activityId?: string
  speaking?: boolean
  level?: number
  emotion?: string
  intensity?: number
  affinity?: number
  reducedMotion?: boolean
}
export interface AvatarSnapshot extends Readonly<AvatarScope> {
  readonly version: 1
  readonly phase: AvatarPhase
  readonly action: 'rest' | 'listen' | 'raise-hand' | 'work' | 'lower-hand'
  readonly hands: 'lowered' | 'raised' | 'working'
  readonly activityId: string
  readonly emotion: string
  readonly intensity: number
  readonly affinity: number | null
  readonly reducedMotion: boolean
  readonly sequence: number
  readonly speech: Readonly<{ playing: boolean; level: number }>
  readonly transition: Readonly<{ from: AvatarPhase | null; to: AvatarPhase; startedAt: number; durationMs: number; easing: 'smoothstep'; interruptible: true }>
}
export interface AvatarEvent {
  readonly type: 'state' | 'audio' | 'dispose'
  readonly scope: Readonly<AvatarScope>
  readonly state: AvatarSnapshot | null
  readonly previous: AvatarSnapshot | null
}
const sources = new Map<symbol, AvatarSnapshot | null>()
const listeners = new Set<{ listener: (event: AvatarEvent) => void; scope?: AvatarScope }>()
const matches = (value: AvatarScope, scope?: AvatarScope) => !scope || value.projectId === scope.projectId && value.sessionId === scope.sessionId
const unit = (value = 0) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0

export function getAvatarState(scope?: AvatarScope): AvatarSnapshot | null {
  return [...sources.values()].reverse().find(value => value && matches(value, scope)) ?? null
}
export function subscribeAvatar(listener: (event: AvatarEvent) => void, scope?: AvatarScope) {
  const entry = { listener, scope }
  listeners.add(entry)
  return () => { listeners.delete(entry) }
}
function emit(event: AvatarEvent) {
  const frozen = Object.freeze(event)
  for (const entry of listeners) if (matches(event.scope, entry.scope)) {
    try { entry.listener(frozen) } catch { /* Presentation extensions cannot break the conversation. */ }
  }
  window.dispatchEvent(new window.CustomEvent(event.type === 'audio' ? AVATAR_AUDIO_EVENT : AVATAR_STATE_EVENT, { detail: frozen }))
}

export function createAvatarSnapshot(scope: AvatarScope, input: AvatarInput, previous: AvatarSnapshot | null, now: number): AvatarSnapshot {
  const playing = Boolean(input.speaking), phase = playing ? 'speaking' : input.phase
  const emotion = input.emotion || 'calm', intensity = unit(input.intensity), reducedMotion = Boolean(input.reducedMotion)
  const affinity = input.affinity == null || !Number.isFinite(input.affinity) ? null : Math.max(0, Math.min(100, input.affinity))
  const activityId = input.activityId || phase
  const semanticChange = !previous || previous.phase !== phase || previous.activityId !== activityId || previous.emotion !== emotion || previous.intensity !== intensity || previous.reducedMotion !== reducedMotion || previous.affinity !== affinity
  const level = playing ? Math.round(unit(input.level) * 1000) / 1000 : 0
  if (!semanticChange && previous!.speech.playing === playing && previous!.speech.level === level) return previous!
  const action = phase === 'thinking' ? 'raise-hand' : phase === 'working' ? 'work' : phase === 'replying' || phase === 'speaking' ? 'lower-hand' : phase === 'listening' ? 'listen' : 'rest'
  return Object.freeze({
    ...scope, version: 1, phase, action, hands: action === 'raise-hand' ? 'raised' : action === 'work' ? 'working' : 'lowered',
    activityId, emotion, intensity, affinity, reducedMotion, sequence: (previous?.sequence ?? 0) + (semanticChange ? 1 : 0),
    speech: Object.freeze({ playing, level }),
    transition: semanticChange ? Object.freeze({ from: previous?.phase ?? null, to: phase, startedAt: now, durationMs: reducedMotion ? 0 : phase === 'thinking' || phase === 'working' ? 650 : action === 'lower-hand' ? 600 : 400, easing: 'smoothstep', interruptible: true }) : previous!.transition,
  })
}

/** A mounted source owns only presentation state, never chat text or audio payloads. */
export function createAvatarSource(scope: AvatarScope) {
  const owner = Symbol(), identity = Object.freeze({ ...scope })
  let state: AvatarSnapshot | null = null, disposed = false
  sources.set(owner, null)
  return {
    update(input: AvatarInput, now = performance.now()) {
      if (disposed) throw new Error('形象状态源已关闭')
      const previous = state
      state = createAvatarSnapshot(identity, input, previous, now)
      sources.set(owner, state)
      if (state !== previous) {
        if (state.sequence !== previous?.sequence) emit({ type: 'state', scope: identity, state, previous })
        if (state.speech.playing !== (previous?.speech.playing ?? false) || state.speech.level !== (previous?.speech.level ?? 0)) emit({ type: 'audio', scope: identity, state, previous })
      }
      return state
    },
    dispose() {
      if (disposed) return
      disposed = true; sources.delete(owner)
      if (state) emit({ type: 'dispose', scope: identity, state: null, previous: state })
    },
  }
}
