import type {OrbValues} from './presenceOrb'
export type PresencePhase='idle'|'listening'|'thinking'|'working'|'speaking'
const targets:Record<PresencePhase,Omit<OrbValues,'rotation'>>={
 idle:{radius:.82,spin:.10,scatter:0,pulse:.10,heat:0},
 listening:{radius:.91,spin:.15,scatter:.03,pulse:.16,heat:0},
 thinking:{radius:.73,spin:.46,scatter:.08,pulse:.12,heat:.72},
 working:{radius:.88,spin:.30,scatter:.12,pulse:.13,heat:.25},
 speaking:{radius:.91,spin:.16,scatter:.03,pulse:.10,heat:0},
}
export function presenceTarget(phase:string):PresencePhase{return phase==='checking'?'thinking':phase==='replying'?'working':Object.hasOwn(targets,phase)?phase as PresencePhase:'idle'}
export function advancePresence(previous:OrbValues,phase:PresencePhase,deltaMs:number){
 const target=targets[phase],dt=Math.min(100,Math.max(0,deltaMs))/1000,a=1-Math.exp(-dt/.55)
 const next={...previous};for(const key of ['radius','spin','scatter','pulse','heat'] as const)next[key]+=(target[key]-next[key])*a
 next.rotation+=dt*next.spin;return next
}
export const initialPresence:OrbValues={...targets.idle,rotation:0}
