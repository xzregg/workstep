import type { DigitalPersonProfile } from '../../api/digitalPerson'
export const PROACTIVE_MESSAGE = 'workstep:digital-person-proactive-message'
export const PROACTIVE_SPEECH_CHANGED = 'workstep:digital-person-proactive-speech-changed'
export interface ProactiveMessage { projectId:string; sessionId:string; messageId:string; text:string }
export interface ProactiveSpeechContext { projectId:string; sessionId:string; profile:DigitalPersonProfile; muted:boolean }
let context:ProactiveSpeechContext|null=null
export function setProactiveSpeechContext(value:ProactiveSpeechContext|null) {
 context=value
 window.dispatchEvent(new window.Event(PROACTIVE_SPEECH_CHANGED))
}
export function getProactiveSpeechContext(){return context}
export function dispatchProactiveMessage(event:Record<string,any>){
 if(event.type!=='CUSTOM'||event.name!=='digital_person.proactive_message'||event.channel!=='digital_person')return
 const {project_id,session_id,value}=event
 if(typeof project_id!=='string'||typeof session_id!=='string'||typeof value?.message_id!=='string'||typeof value?.text!=='string'||!value.text.trim())return
 window.dispatchEvent(new window.CustomEvent<ProactiveMessage>(PROACTIVE_MESSAGE,{detail:{projectId:project_id,sessionId:session_id,messageId:value.message_id,text:value.text}}))
}
