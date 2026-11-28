import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties} from 'react'
import {createPortal} from 'react-dom'
import {digitalCalendarApi,type CalendarEvent} from '../../api/digitalCalendar'
import {localizeErrorDisplay,useI18n} from '../../i18n'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import ConfirmDialog from '../ConfirmDialog'
import MarkdownMessage from '../MarkdownMessage'
import DigitalCalendarEditor from './DigitalCalendarEditor'
import {useCalendarEvents} from './useCalendarEvents'
import './DigitalPersonCalendar.css'
import {nativeCalendarApi} from '../../api/nativeCalendar'
import {useNativeCalendarStore,openDigitalCalendar} from '../../stores/nativeCalendarStore'

const sameDay=(a:Date,b:Date)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()
const dayKey=(date:Date)=>`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

function calendarTimeRange(event:CalendarEvent,locale:string){
 const start=new Date(event.starts_at),end=new Date(start.getTime()+(event.duration_minutes??30)*60000)
 const clock=(date:Date)=>date.toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit',hour12:false})
 if(event.system_readonly&&event.duration_minutes==null)return clock(start)
 return `${clock(start)} – ${sameDay(start,end)?'':end.toLocaleDateString(locale,{month:'numeric',day:'numeric'})+' '}${clock(end)}`
}

/** One calendar owns desktop hover and touch panel disclosure, editing and deletion. */
export default function DigitalPersonCalendar({active,projectId,canEdit,presentation='home'}:{active:boolean;projectId:string;canEdit:boolean;presentation?:'home'|'panel'}){
 const {t,locale}=useI18n(),compact=useCompactLayout(),root=useRef<HTMLDivElement>(null),popover=useRef<HTMLDivElement>(null)
 const panel=presentation==='panel'
 const [selected,setSelected]=useState(()=>new Date())
 const [viewDate,setViewDate]=useState<Date|null>(null)
 const [month,setMonth]=useState(()=>new Date(new Date().getFullYear(),new Date().getMonth(),1))
 const [top,setTop]=useState(320),[hover,setHover]=useState<{date:Date;anchor:HTMLElement}|null>(null),[position,setPosition]=useState({left:8,top:8})
 const [editor,setEditor]=useState<{date:Date;event?:CalendarEvent}|null>(null),[busy,setBusy]=useState(''),[actionError,setActionError]=useState('')
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),busyRef=useRef(false)
 const start=new Date(month.getFullYear(),month.getMonth(),1-(month.getDay()+6)%7)
 const cells=Math.ceil(((month.getDay()+6)%7+new Date(month.getFullYear(),month.getMonth()+1,0).getDate())/7)*7
 const end=new Date(start);end.setDate(end.getDate()+cells)
 const {items,loading,error,systemNotice,reload}=useCalendarEvents(active&&(panel||!compact),start.toISOString(),end.toISOString())
 const [today,setToday]=useState(()=>new Date())
 const dateLabel=(date:Date)=>date.toLocaleDateString(locale,{month:'long',day:'numeric',weekday:'short'})
 const groups=new Map<string,CalendarEvent[]>()
 for(const item of items){const key=dayKey(new Date(item.starts_at));groups.set(key,[...(groups.get(key)??[]),item])}
 const hide=()=>{clearTimeout(timer.current);setHover(null)}
 const delayHide=()=>{clearTimeout(timer.current);timer.current=setTimeout(()=>setHover(null),180)}
 const show=(date:Date,anchor:HTMLElement)=>{clearTimeout(timer.current);timer.current=setTimeout(()=>setHover({date,anchor}),180)}
 useEffect(()=>()=>clearTimeout(timer.current),[])
 useEffect(()=>{
  if(!active)return
  const tick=window.setInterval(()=>{const now=new Date();setToday(previous=>sameDay(previous,now)?previous:now)},30000)
  return()=>window.clearInterval(tick)
 },[active])
 useLayoutEffect(()=>{
  const main=root.current?.closest('.digital-home-main'),info=main?.querySelector('.digital-home-presence-info')
  if(!main||!info)return
  const measure=()=>setTop(info.getBoundingClientRect().bottom-main.getBoundingClientRect().top+16)
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure)
  observer?.observe(main);observer?.observe(info);measure()
  return()=>observer?.disconnect()
 },[active,compact])
 useLayoutEffect(()=>{
  if(!hover)return
  const place=()=>{
   if(!hover.anchor.isConnected){setHover(null);return}
   const anchor=hover.anchor.getBoundingClientRect(),box=popover.current?.getBoundingClientRect()
   const width=box?.width??320,height=box?.height??240
   setPosition({left:Math.max(8,Math.min(window.innerWidth-width-8,anchor.left-width-12)),top:Math.max(8,Math.min(window.innerHeight-height-8,anchor.top+anchor.height/2-height/2))})
  }
  place();window.addEventListener('resize',hide);window.addEventListener('scroll',hide,true)
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(place)
  if(popover.current)observer?.observe(popover.current)
  return()=>{observer?.disconnect();window.removeEventListener('resize',hide);window.removeEventListener('scroll',hide,true)}
 },[hover])
 const open=(date:Date,event?:CalendarEvent)=>{
  if(!canEdit)return
  hide();setViewDate(null)
  const at=new Date(date)
  if(!event){const now=new Date();at.setHours(sameDay(at,now)?now.getHours():9,sameDay(at,now)?now.getMinutes()+5:0,0,0)}
  setEditor({date:at,event})
 }
 const remove=async(event:CalendarEvent)=>{
  if(busyRef.current)return
  busyRef.current=true;setBusy(event.id);setActionError('')
  try{
   if(event.target_id&&event.target_id!=='internal'){
    useNativeCalendarStore.getState().observe(await nativeCalendarApi.submit({action:'delete',target_id:event.target_id,event_id:event.id,revision:event.revision,request_id:crypto.randomUUID()}));hide()
   }else await digitalCalendarApi.remove(event)
   reload()
  }catch(reason){setActionError(localizeErrorDisplay(reason instanceof Error?reason.message:String(reason)))}finally{busyRef.current=false;setBusy('')}
 }
 const changeMonth=(delta:number)=>{hide();const next=new Date(month.getFullYear(),month.getMonth()+delta,1);setMonth(next);setSelected(next)}
 const entries=(date:Date)=>(groups.get(dayKey(date))??[]).length?(groups.get(dayKey(date))??[]).map(event=><section key={event.id} className="digital-calendar-entry">
  <header><time>{event.all_day?t('nativeCalendar.allDay'):calendarTimeRange(event,locale)}</time><span>{event.system_readonly?t('nativeCalendar.readOnly'):event.reminder_status==='system'?'':event.reminder_status==='notified'?t('digitalCalendar.notified'):event.reminder_status==='retry'?t('digitalCalendar.retrying'):''}</span>{canEdit&&!event.system_readonly&&<div><Button variant={compact?'ghost':'icon'} className="digital-calendar-edit" aria-label={t('digitalCalendar.edit')} disabled={!!busy} onClick={()=>open(date,event)}><Icon name="pencil"/>{compact&&<span>{t('common.edit')}</span>}</Button><Button variant="icon" aria-label={t('digitalCalendar.delete')} loading={busy===event.id} disabled={!!busy} onClick={()=>void remove(event)}><Icon name="trash" size={14}/></Button></div>}</header>
  <MarkdownMessage content={event.content} projectId={projectId} reveal="off"/>
 </section>):<p className="digital-calendar-empty">{t('digitalCalendar.empty')}</p>
 return <>
  {compact&&!panel&&active&&<Button variant="ghost" className="digital-home-calendar-entry" onClick={()=>openDigitalCalendar(projectId,canEdit)} aria-haspopup="dialog"><Icon name="calendar" size={16}/><span>{t('digitalCalendar.entry')}</span></Button>}
  <div ref={root} className={panel?'digital-calendar-panel':'digital-home-calendar'} style={panel?undefined:{'--calendar-top':`${top}px`} as CSSProperties} hidden={!active||(compact&&!panel)} aria-label={t('digitalCalendar.title')}>
   {!panel&&<header><h2>{t('digitalCalendar.title')}{loading&&<Spinner size={12}/>}</h2><div><Button variant="ghost" size="sm" onClick={()=>{hide();setSelected(today);setMonth(new Date(today.getFullYear(),today.getMonth(),1))}}>{t('digitalCalendar.today')}</Button>{canEdit&&<Button variant="icon" aria-label={t('digitalCalendar.add')} onClick={()=>open(today)}><Icon name="plus"/></Button>}</div></header>}
   <div className="digital-calendar-month"><strong>{month.toLocaleDateString(locale,{year:'numeric',month:'long'})}{panel&&loading&&<Spinner size={12}/>}</strong><nav>{panel&&<Button className="digital-calendar-today" variant="ghost" size="sm" onClick={()=>{hide();setSelected(today);setMonth(new Date(today.getFullYear(),today.getMonth(),1))}}>{t('digitalCalendar.today')}</Button>}<Button variant="icon" aria-label={t('digitalCalendar.previousMonth')} onClick={()=>changeMonth(-1)}><Icon name="chevron-left"/></Button><Button variant="icon" aria-label={t('digitalCalendar.nextMonth')} onClick={()=>changeMonth(1)}><Icon name="chevron-right"/></Button></nav></div>
   <div className="digital-calendar-weekdays" aria-hidden="true">{Array.from({length:7},(_,index)=><span key={index}>{new Date(2026,0,5+index).toLocaleDateString(locale,{weekday:'narrow'})}</span>)}</div>
   <div className="digital-calendar-grid">{Array.from({length:cells},(_,index)=>{
    const date=new Date(start);date.setDate(date.getDate()+index)
    const rows=groups.get(dayKey(date))??[],expanded=Boolean((hover&&sameDay(hover.date,date))||(viewDate&&sameDay(viewDate,date)))
    return <button type="button" key={date.toISOString()} className="digital-calendar-day" data-date={dayKey(date)} data-today={sameDay(date,today)} data-other-month={date.getMonth()!==month.getMonth()} data-has-events={rows.length>0}
     aria-label={t('digitalCalendar.day',{date:dateLabel(date),count:rows.length})} aria-haspopup="dialog" aria-expanded={expanded}
     data-selected={panel&&sameDay(selected,date)} onMouseEnter={e=>{if(!panel)show(date,e.currentTarget)}} onMouseLeave={delayHide} onFocus={e=>{if(!panel)show(date,e.currentTarget)}} onBlur={e=>{if(!popover.current?.contains(e.relatedTarget))delayHide()}}
     onClick={()=>{setSelected(date);hide();if(rows.length)setViewDate(date);else open(date)}} onKeyDown={e=>{const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[e.key];if(delta){e.preventDefault();const next=new Date(date);next.setDate(next.getDate()+delta);root.current?.querySelector<HTMLButtonElement>(`[data-date="${dayKey(next)}"]`)?.focus()}if(e.key==='Escape')hide()}}>{date.getDate()}</button>
   })}</div>
   {systemNotice&&<p className="digital-calendar-zone" role="status">{t(systemNotice as never)}</p>}
   {(error||actionError)&&<div className="digital-calendar-error" role="alert">{error?t('digitalCalendar.loadFailed'):actionError}<Button variant="ghost" size="sm" onClick={reload}>{t('common.retry')}</Button></div>}
   {panel&&canEdit&&<Button variant="primary" className="digital-calendar-add" onClick={()=>open(selected)}><Icon name="plus"/><span>{t('digitalCalendar.add')}</span></Button>}
  </div>
  {hover&&!editor&&!viewDate&&active&&!compact&&!panel&&createPortal(<div ref={popover} className="digital-calendar-popover" role="dialog" aria-label={dateLabel(hover.date)} style={position} onMouseEnter={()=>clearTimeout(timer.current)} onMouseLeave={delayHide} onFocus={()=>clearTimeout(timer.current)} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))delayHide()}} onKeyDown={e=>{if(e.key==='Escape'){hide();hover.anchor.focus()}}}>
   <header className="digital-calendar-day-heading"><h3>{dateLabel(hover.date)}</h3><div>{canEdit&&<Button size="sm" aria-label={t('digitalCalendar.add')} onClick={()=>open(hover.date)}>{t('digitalCalendar.add')}</Button>}</div></header>{entries(hover.date)}
  </div>,document.body)}
  {viewDate&&active&&createPortal(<ConfirmDialog open className="digital-calendar-day-window" title={dateLabel(viewDate)} width={480} zIndex={1350} noConfirm={!canEdit} confirmText={t('digitalCalendar.add')} cancelText={t('common.close')} onConfirm={()=>open(viewDate)} onCancel={()=>{if(!busy)setViewDate(null)}}>
   <div className="digital-calendar-day-dialog">{entries(viewDate)}
    {actionError&&<p className="digital-calendar-error" role="alert">{actionError}</p>}
   </div>
  </ConfirmDialog>,document.body)}
  {editor&&<DigitalCalendarEditor key={editor.event?.id??editor.date.toISOString()} {...editor} projectId={projectId} onClose={()=>setEditor(null)} onSaved={reload}/>}
 </>
}
