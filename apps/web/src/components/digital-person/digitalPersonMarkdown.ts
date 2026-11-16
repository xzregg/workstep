import type {DigitalPersonProfile} from '../../api/digitalPerson'

export type DocumentHeadings = {role:string;personality:string;tone:string;relationship:string;greeting:string;duties:string;boundary:string;memory:string}
export const defaultHeadings:DocumentHeadings={role:'身份',personality:'性格',tone:'语气',relationship:'相处',greeting:'欢迎语',duties:'主要职责',boundary:'执行红线',memory:'长期约定'}
const aliases:Record<keyof DocumentHeadings,string[]>={role:['身份','Identity'],personality:['性格','Personality'],tone:['语气','Tone'],relationship:['相处','Relationship'],greeting:['欢迎语','Greeting'],duties:['主要职责','Duties'],boundary:['执行红线','Boundary'],memory:['长期约定','Standing memory']}
function section(text:string,key:keyof DocumentHeadings,h:DocumentHeadings){
 const lines=text.split('\n'),names=[h[key],...aliases[key]].map(x=>x.toLowerCase())
 const start=lines.findIndex(line=>/^##\s+/.test(line)&&names.includes(line.replace(/^##\s+/,'').trim().toLowerCase()))
 let end=start+1
 if(start>=0)while(end<lines.length&&!/^#{1,2}\s+/.test(lines[end]))end++
 return {lines,start,end,body:start<0?[]:lines.slice(start+1,end)}
}
export function documentSection(text:string,key:keyof DocumentHeadings,h=defaultHeadings){return section(text,key,h).body.map(x=>x.replace(/^\s*-\s+/, '').trim()).filter(Boolean)}
export function setDocumentSection(text:string,key:keyof DocumentHeadings,body:string[],h=defaultHeadings){
 const part=section(text,key,h),replacement=['## '+h[key],...body]
 if(part.start<0)return [text.trimEnd(),replacement.join('\n')].filter(Boolean).join('\n\n')
 const tail=part.lines.slice(part.end)
 return [...part.lines.slice(0,part.start),...replacement,...(tail.length?['',...tail]:[])].join('\n')
}
export function toggleDocumentItem(text:string,key:keyof DocumentHeadings,item:string,h=defaultHeadings){
 const part=section(text,key,h),body=part.body.filter(x=>x.trim())
 const exists=body.some(x=>x.trim()==='- '+item||x.trim()===item)
 return setDocumentSection(text,key,exists?body.filter(x=>x.trim()!==item&&x.trim()!=='- '+item):[...body,'- '+item],h)
}
export function personaDocument(profile:DigitalPersonProfile,h=defaultHeadings,style=''){
 if(profile.persona_markdown!=null)return profile.persona_markdown
 const block=(key:keyof DocumentHeadings,value:string)=>value?`## ${h[key]}\n${value}`:''
 return [block('role',profile.role),block('personality',profile.personality),block('tone',profile.tone??''),block('relationship',[style,profile.relationship_preferences].filter(Boolean).join('\n')),block('greeting',profile.greeting)].filter(Boolean).join('\n\n')
}
/** Maintain legacy display fields without using them as a second prompt source. */
export function withPersonaDocument(profile:DigitalPersonProfile,text:string,h=defaultHeadings):DigitalPersonProfile{
 const value=(key:keyof DocumentHeadings,fallback:string,limit:number)=>documentSection(text,key,h).join('、').slice(0,limit)||fallback
 return {...profile,persona_markdown:text,role_binding:null,role:value('role',profile.role,200),personality:value('personality',profile.personality,2000),tone:value('tone',profile.tone??'',1000),greeting:value('greeting',profile.greeting,500)}
}
