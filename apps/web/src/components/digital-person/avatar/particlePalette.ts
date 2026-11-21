import type {AvatarCallState,AvatarPhase} from '../../../avatars/runtime'
import type {RobotAvatarState} from '../../../utils/robotAvatarState'

export const colors={idle:[.26,.62,.84,0],wake:[.53,.80,.94,.62],ready:[.31,.65,.83,.54],listening:[.52,.87,.96,.74],
 transcribe:[.39,.74,.89,.60],sending:[.26,.61,.82,.62],thinking:[.32,.50,.77,.37],check:[.35,.57,.76,.60],
 work:[.18,.55,.81,.72],write:[.35,.67,.86,.62],wait:[.48,.65,.74,.74],synth:[.41,.69,.88,.62],
 playing:[.35,.67,.91,.36],done:[.49,.78,.89,.67],muted:[.42,.54,.61,.78],stopped:[.39,.56,.66,.67],error:[.31,.48,.63,.80]};
export type OrbPhase=keyof typeof colors
export const callStates:Record<OrbPhase,AvatarCallState>={
 idle:'idle',wake:'waitingForWake',ready:'preparing',listening:'listening',transcribe:'transcribing',
 sending:'sending',thinking:'thinking',check:'checking',work:'working',write:'replying',
 wait:'awaitingConfirmation',synth:'synthesizing',playing:'speaking',done:'completed',
 muted:'muted',stopped:'stopped',error:'error',
}
export const poses:Partial<Record<OrbPhase,number[]>>={listening:[.9,0,0],transcribe:[.55,.1,0],thinking:[-.5,.68,0],check:[-.24,.32,0],work:[0,1,0],write:[.18,.46,0],ready:[.2,.14,0],synth:[.4,0,0],wait:[0,0,.32],muted:[0,0,.65],error:[0,0,.5]};


interface CallSignals {
  phase: AvatarPhase
  message?: RobotAvatarState
  waitingForWake?: boolean
  voicePhase: string
  playing: boolean
  outputBusy: boolean
  sending: boolean
  error: boolean
  muted: boolean
  microphoneOn: boolean
  checking: boolean
}

export function orbPhaseFor(call: CallSignals): OrbPhase {
  if (call.playing) return 'playing'
  if (call.error) return 'error'
  if (call.outputBusy) return 'synth'
  if (call.sending) return 'sending'
  if (call.voicePhase === 'finishing') return 'transcribe'
  if (call.voicePhase === 'preparing' || call.voicePhase === 'requesting') return 'ready'
  if (call.message === 'waiting') return 'wait'
  if (call.message === 'failed') return 'error'
  if (call.message === 'stopped') return 'stopped'
  if (call.checking) return 'check'
  if (call.phase === 'working') return 'work'
  if (call.phase === 'replying') return 'write'
  if (call.phase === 'thinking') return 'thinking'
  if (call.microphoneOn) return 'listening'
  if (call.muted) return 'muted'
  return call.waitingForWake ? 'wake' : 'idle'
}
