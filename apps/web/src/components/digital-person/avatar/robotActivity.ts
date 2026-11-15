import type {AssistantChatMessage} from '../../../stores/assistantStore'
import {resolveRobotAvatarState} from '../../../utils/robotAvatarState'
import type {RobotActivity} from './robotRig'

/** Reuse message lifecycle semantics; chunk growth must not restart gestures. */
export function selectRobotActivity(messages:AssistantChatMessage[],running:boolean):RobotActivity|null {
 if(!running)return null
 const message=messages.findLast(item=>item.role==='assistant'&&item.engine!=='action')
 if(!message)return {kind:'think',key:'awaiting-reply'}
 if(message.status!=='running')return null
 const events=message.events??[]
 const phase=resolveRobotAvatarState({streaming:true,content:message.content,events})
 if(['waiting','done','failed','stopped'].includes(phase))return null
 if(phase==='working'||phase==='searching'){
  const tool=events.findLast(event=>['TOOL_CALL_START','TOOL_CALL_ARGS','TOOL_CALL_CHUNK'].includes(event.type))
  return {kind:'work',key:`${message.id}:work:${tool?.toolCallId??tool?.toolCallName??'active'}`}
 }
 const kind=phase==='writing'?'reply':'think'
 return {kind,key:`${message.id}:${kind}`}
}
