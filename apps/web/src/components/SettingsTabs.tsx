import Button from './Button'
import './SettingsTabs.css'

export default function SettingsTabs<T extends string>({tabs,selected,onSelect,disabled=false,panelId,label,className=''}:{
 tabs:readonly {id:T;label:string}[];selected:T;onSelect:(tab:T)=>void;disabled?:boolean;panelId:string;label:string;className?:string
}){
 return <nav className={`settings-tabs ${className}`} role="tablist" aria-label={label}>
  {tabs.map(({id,label},index)=><Button key={id} id={`${panelId}-${id}`} role="tab" aria-selected={selected===id} aria-controls={panelId}
   tabIndex={selected===id?0:-1} disabled={disabled} onClick={()=>onSelect(id)} onKeyDown={event=>{
    if(disabled||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault()
    const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1)!:tabs[(index+(event.key==='ArrowLeft'?tabs.length-1:1))%tabs.length]
    onSelect(next.id)
    document.getElementById(`${panelId}-${next.id}`)?.focus()
   }}>{label}</Button>)}
 </nav>
}
