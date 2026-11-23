import type {DigitalPersonProfile} from '../../api/digitalPerson'
import {unified} from 'unified'
import remarkParse from 'remark-parse'

export type DocumentHeadings = {role:string;personality:string;tone:string;relationship:string;greeting:string;duties:string;boundary:string;memory:string}
export const defaultHeadings:DocumentHeadings={role:'身份',personality:'性格',tone:'语气',relationship:'相处',greeting:'欢迎语',duties:'主要职责',boundary:'执行红线',memory:'长期约定'}
const aliases:Record<keyof DocumentHeadings,string[]>={
 role:['身份','身分','Identity','身分・役割','Identität','Identité','الهوية'],
 personality:['性格','Personality','Persönlichkeit','Caractère','الطباع'],
 tone:['语气','語氣','Tone','口調','Tonfall','Ton','النبرة'],
 relationship:['相处','相處','Relationship','接し方','Umgang','Relation','أسلوب التعامل'],
 greeting:['欢迎语','歡迎語','Greeting','挨拶','Begrüßung','Message d’accueil','الترحيب'],
 duties:['主要职责','主要職責','职责','職責','Duties','Responsibilities','主な役割','Hauptaufgaben','Responsabilités principales','المسؤوليات الرئيسية'],
 boundary:['执行红线','執行紅線','Boundary','Execution boundary','実行上の制約','Ausführungsgrenze','Limite d’exécution','حدود التنفيذ'],
 memory:['长期约定','長期約定','Standing memory','Standing agreements','継続的な約束','Dauerhafte Vereinbarungen','Accords permanents','اتفاقات دائمة'],
}
const markdown=unified().use(remarkParse)

function section(text:string,key:keyof DocumentHeadings,h:DocumentHeadings,document=markdown.parse(text)){
 const lines=text.split('\n'),names=[h[key],...aliases[key]].map(x=>x.toLowerCase())
 const startNode=document.children.findIndex(node=>node.type==='heading'&&node.depth===2&&node.children.length===1&&node.children[0].type==='text'&&names.includes(node.children[0].value.toLowerCase()))
 if(startNode<0)return {lines,start:-1,bodyStart:0,end:lines.length,body:[],nodes:[]}
 const heading=document.children[startNode]
 const following=document.children.slice(startNode+1)
 const next=following.findIndex(node=>node.type==='heading'&&node.depth<=2)
 const start=heading.position!.start.line-1
 const bodyStart=heading.position!.end.line
 const end=next<0?lines.length:following[next].position!.start.line-1
 return {lines,start,bodyStart,end,body:lines.slice(bodyStart,end),nodes:next<0?following:following.slice(0,next)}
}
export function documentSection(text:string,key:keyof DocumentHeadings,h=defaultHeadings){return section(text,key,h).body.map(x=>x.replace(/^\s*-\s+/, '').trim()).filter(Boolean)}
export function setDocumentSection(text:string,key:keyof DocumentHeadings,body:string[],h=defaultHeadings){
 const part=section(text,key,h),replacement=['## '+h[key],...body]
 if(part.start<0)return [text.trimEnd(),replacement.join('\n')].filter(Boolean).join('\n\n')
 const tail=part.lines.slice(part.end)
 return [...part.lines.slice(0,part.start),...replacement,...(tail.length?['',...tail]:[])].join('\n')
}
export function toggleDocumentItem(text:string,key:keyof DocumentHeadings,item:string,h=defaultHeadings){
 const part=section(text,key,h)
 const selected=presetLines(part).some(entry=>entry.text===item)
 return editPresetLines(text,key,part,selected?[]:[item],selected?[item]:[],h)
}

function presetLines(part:ReturnType<typeof section>){
 return part.nodes.flatMap(node=>{
  const entries=node.type==='list'&&!node.ordered?node.children:node.type==='paragraph'?[node]:[]
  return entries.flatMap(entry=>{
   const {start,end}=entry.position!
   if(start.line!==end.line)return []
   const raw=part.lines[start.line-1].trim()
   return [{line:start.line-1,text:entry.type==='listItem'?raw.replace(/^[-+*]\s+/,''):raw}]
  })
 })
}

export function documentPresetItems(text:string,keys:(keyof DocumentHeadings)[],h=defaultHeadings){
 const document=markdown.parse(text)
 return keys.map(key=>new Set(presetLines(section(text,key,h,document)).map(entry=>entry.text)))
}

export function applyDocumentPresets(text:string,key:keyof DocumentHeadings,items:string[],replace:string[],h=defaultHeadings){
 return editPresetLines(text,key,section(text,key,h),items,replace,h)
}

function editPresetLines(text:string,key:keyof DocumentHeadings,part:ReturnType<typeof section>,items:string[],replace:string[],h:DocumentHeadings){
 const presets=presetLines(part)
 const removed=new Set(presets.filter(entry=>replace.includes(entry.text)&&!items.includes(entry.text)).map(entry=>entry.line))
 const added=items.filter(item=>!presets.some(entry=>entry.text===item)).map(item=>'- '+item)
 if(part.start<0)return added.length?[text,`## ${h[key]}\n${added.join('\n')}`].filter(Boolean).join('\n\n'):text
 const {lines,bodyStart,end}=part
 let insert=end
 while(insert>bodyStart&&!lines[insert-1].trim())insert--
 return [...lines.slice(0,insert).filter((_,i)=>!removed.has(i)),...added,...lines.slice(insert)].join('\n')
}
export function personaDocument(profile:DigitalPersonProfile,h=defaultHeadings,style=''){
 if(profile.persona_markdown!=null)return profile.persona_markdown
 const block=(key:keyof DocumentHeadings,value:string)=>value?`## ${h[key]}\n${value}`:''
 return [block('role',profile.role),block('personality',profile.personality),block('tone',profile.tone??''),block('relationship',[style,profile.relationship_preferences].filter(Boolean).join('\n')),block('greeting',profile.greeting)].filter(Boolean).join('\n\n')
}
/** Maintain legacy display fields without using them as a second prompt source. */
export function withPersonaDocument(profile:DigitalPersonProfile,text:string,h=defaultHeadings):DigitalPersonProfile{
 const document=markdown.parse(text)
 const value=(key:keyof DocumentHeadings,limit:number)=>section(text,key,h,document).body.map(line=>line.replace(/^[-+*]\s+/,'')).join('\n').trim().slice(0,limit)
 return {...profile,persona_markdown:text,role_binding:null,role:value('role',200)||profile.role,personality:value('personality',2000),tone:value('tone',1000),greeting:value('greeting',500)||profile.greeting}
}
