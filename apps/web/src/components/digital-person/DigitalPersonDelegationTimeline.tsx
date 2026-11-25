import {useEffect,useRef} from 'react'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import type {DigitalActivityRecords} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'

type Delegation = DigitalActivityRecords['delegations'][number]
const activeStatuses = ['queued', 'running', 'stopping']
const statusKeys = {
 archived: 'digitalPerson.statusArchived',
 queued: 'digitalPerson.statusQueued',
 running: 'digitalPerson.homeTaskRunning',
 stopping: 'digitalPerson.homeTaskRunning',
 completed: 'digitalPerson.statusCompleted',
 succeeded: 'digitalPerson.statusCompleted',
 failed: 'digitalPerson.statusError',
 error: 'digitalPerson.statusError',
 stopped: 'digitalPerson.statusStopped',
 cancelled: 'digitalPerson.statusCancelled',
 interrupted: 'digitalPerson.statusInterrupted',
 unavailable: 'digitalPerson.homeTaskUnavailable',
} as const

function groupByDay(items: Delegation[]) {
 const dated = items.map(item => {
  const stamp = Date.parse(item.created_at ?? '')
  return {item, stamp: Number.isFinite(stamp) ? stamp : -Infinity}
 }).sort((a,b)=>b.stamp-a.stamp)
 const days = new Map<string, {item: Delegation; date: Date | null}[]>()
 for (const {item, stamp} of dated) {
  const date = Number.isFinite(stamp) ? new Date(stamp) : null
  const key = date?.toDateString() ?? ''
  const row = {item, date}
  const day = days.get(key)
  if (day) day.push(row)
  else days.set(key, [row])
 }
 return days
}

export default function DigitalPersonDelegationTimeline({items, viewedResults, loading, pageError, canLoadMore, onLoadMore, onOpen}: {
 items: Delegation[]
 viewedResults: Record<string, string>
 loading: boolean
 pageError: boolean
 canLoadMore: boolean
 onLoadMore: () => void
 onOpen: (item: Delegation) => void
}) {
 const {t, locale} = useI18n()
 const compact = useCompactLayout()
 const scroll = useRef<HTMLDivElement>(null)
 useEffect(()=>{
  if(compact || loading || pageError || !canLoadMore)return
  const list=scroll.current
  if(!list)return
  const fill=()=>{
   if(list.clientHeight>0 && list.scrollHeight-list.scrollTop-list.clientHeight<64)onLoadMore()
  }
  fill()
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(fill)
  observer?.observe(list)
  return()=>observer?.disconnect()
 },[compact,items,loading,pageError,canLoadMore,onLoadMore])
 const days = groupByDay(items)
 const years = new Set(Array.from(days.values(), rows=>rows[0].date?.getFullYear()).filter(year=>year!=null))
 const caption = t('digitalPerson.homeDelegatedTasks')

 return <section className="digital-home-work">
  <h3><Icon name="workflow"/>{caption}</h3>
  <div ref={scroll} className="digital-home-activity-scroll" data-activity-scroll="delegations" role="region" aria-label={caption}
   tabIndex={0} onScroll={({currentTarget: list})=>{
    if(!loading && canLoadMore && !pageError && list.scrollHeight-list.scrollTop-list.clientHeight<64)onLoadMore()
   }}>
   {Array.from(days, ([key, rows])=>{
    const date = rows[0].date
    const heading = date?.toLocaleDateString(locale, {
     month:'long', day:'numeric', year:years.size>1?'numeric':undefined,
    }) ?? t('digitalPerson.homeTaskUnknownDate')
    return <div className="digital-home-work-day" key={key}>
     <h4>{heading}</h4>
     <ol>{rows.map(({item, date})=>{
      const title = item.title || item.instruction
      const status = item.archived ? 'archived' : viewedResults[item.id] ?? item.status
      const viewed = viewedResults[item.id] ? true : item.result_viewed
      const pending = activeStatuses.includes(status)
      const label = Object.hasOwn(statusKeys, status)
       ? t(statusKeys[status as keyof typeof statusKeys])
       : t('digitalPerson.homeTaskUnavailable')
      return <li key={item.id}>
       <Button variant="ghost" className="digital-home-work-summary" data-status={status}
        aria-haspopup="dialog" title={title} onClick={()=>onOpen(item)}>
        <Icon name="workflow" size={14}/>
        <span>
         <span className="digital-home-event-heading">
          <strong>{title}</strong>
          {date&&<time dateTime={item.created_at} title={date.toLocaleString(locale)}>
           {date.toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}
          </time>}
         </span>
         <small className="digital-home-event-meta">
          {pending&&<Icon name="loader-circle" className="task-status-spinner" size={12}/>}
          <span className="digital-home-work-status">{label}</span>
          {!pending&&viewed!=null&&<span className="digital-home-work-viewed" data-viewed={viewed}>
           {t(viewed?'digitalPerson.homeNotificationRead':'digitalPerson.homeResultUnread')}
          </span>}
         </small>
        </span>
       </Button>
      </li>
     })}</ol>
    </div>
   })}
   {items.length===0&&<p>{t('digitalPerson.homeNoDelegatedTasks')}</p>}
   {loading&&<p role="status"><Spinner size={14}/>{t('common.loading')}</p>}
   {pageError&&!compact&&<p role="alert">{t('taskList.loadFailed')}</p>}
   {!loading&&canLoadMore&&(compact||pageError)&&<Button variant="ghost" className="digital-home-work-next" onClick={onLoadMore}>
    {t(pageError?'common.retry':'digitalPerson.homeLoadOlderTasks')}<Icon name="chevron-down" size={14}/>
   </Button>}
  </div>
 </section>
}
