import {isMemorySearchCommand,toolKind} from '../../utils/toolInput'
import {toolArgs,toolCallId,toolName,toolOutput,type EventLike} from '../../utils/agui'

export const atlasToolEvent='workstep:atlas-tool-event'
type ToolEvent=EventLike & {project_id?:string;channel?:string;kind?:string}
type Result={token:string;ids:string[]}

function knowledgeIds(output:unknown):string[]{
  if(typeof output==='string'){
    const text=output.trim()
    if(text.startsWith('{')||text.startsWith('[')){
      try{return knowledgeIds(JSON.parse(text))}catch{/* A terminal can include a header or truncate JSON. */}
    }
    const ids:string[]=[]
    for(const line of text.split(/\r?\n/)){
      if(/^Source (memory|history):\d+ \|/.test(line))break
      const row=/^(knowledge:\d+) \|/.exec(line)
      if(row)ids.push(row[1])
    }
    return ids
  }
  if(Array.isArray(output))return output.flatMap(knowledgeIds)
  if(!output||typeof output!=='object')return []
  const row=output as Record<string,unknown>
  if(row.ok===false||(typeof row.exit_code==='number'&&row.exit_code!==0))return []
  if(Array.isArray(row.knowledge))return row.knowledge.flatMap(item=>
    typeof item?.id==='string'&&/^knowledge:\d+$/.test(item.id)?[item.id]:[])
  return knowledgeIds(row.stdout??row.aggregated_output??row.output??row.content??row.text)
}

// The listener exists only while this atlas is mounted. No history or HTTP fallback.
export function trackAtlasCalls(project:string,session:string,receive:(result:Result)=>void){
  const pending=new Map<string,{input:unknown}>()
  return (event:ToolEvent)=>{
    if(event.project_id!==project||event.session_id!==session||
      (event.channel!=='session_chat'&&event.channel!=='channel_chat'))return
    const id=toolCallId(event)
    if(!id)return
    const token=JSON.stringify([event.messageId??event.message_id??'',id])
    if(event.type==='TOOL_CALL_START'){
      if(toolKind(toolName(event),event.kind)==='command'){
        if(!pending.has(token))pending.set(token,{input:undefined})
        if(pending.size>128)pending.delete(pending.keys().next().value!)
      }
      return
    }
    const call=pending.get(token)
    if(!call)return
    if(event.type==='TOOL_CALL_ARGS')call.input=toolArgs(event)
    if(event.type==='TOOL_CALL_CHUNK'&&typeof toolArgs(event)==='string'&&
      (call.input==null||typeof call.input==='string'))call.input=String(call.input??'')+String(toolArgs(event))
    if(event.type==='TOOL_CALL_RESULT'){
      pending.delete(token)
      if(!event.isError&&isMemorySearchCommand(call.input)){
        receive({token,ids:[...new Set(knowledgeIds(toolOutput(event)))]})
      }
    }
  }
}
