import type {VoicePhase} from '../../hooks/useVoiceInput'
import {create} from 'zustand'
export type WakeSensitivity='low'|'balanced'|'high'
export const normalizeWakeText=(s:string)=>s.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}]/gu,'')
export function wakeMatches(text:string,keyword:string,sensitivity:WakeSensitivity){
 const source=normalizeWakeText(text),target=normalizeWakeText(keyword)
 if(!target)return false
 if(sensitivity==='low')return source===target
 if(source.includes(target))return true
 if(sensitivity!=='high'||target.length<4)return false
 for(let i=0;i<=source.length-target.length;i++){
  let differences=0
  for(let j=0;j<target.length;j++)if(source[i+j]!==target[j])differences++
  if(differences<=1)return true
 }
 return false
}
/** Ephemeral consent: page reloads never start microphone capture. */
export const useWakeState=create<{phase:VoicePhase;listening:boolean;activationPending:boolean;keyword:string;sensitivity:WakeSensitivity;error:string}>(()=>({phase:'idle',listening:false,activationPending:false,keyword:'',sensitivity:'balanced',error:''}))
