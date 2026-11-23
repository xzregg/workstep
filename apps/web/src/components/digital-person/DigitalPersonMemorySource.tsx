import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { digitalMemoryApi, type MemorySource, type MemorySourcePage } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import { useOverlay } from '../../hooks/useOverlay'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import { formatConversationDateTime, toMilliseconds } from '../../utils/datetime'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import ResizablePanel from '../ResizablePanel'

function SourceRecord({source,onCompanion}:{source:MemorySource;onCompanion?:(companion:MemorySourcePage['companion'])=>void}) {
  const {t}=useI18n()
  const [page,setPage]=useState<MemorySourcePage|null>(null),[content,setContent]=useState('')
  const [offset,setOffset]=useState(0),[revision,setRevision]=useState(0)
  const [loading,setLoading]=useState(true),[error,setError]=useState(false),[changed,setChanged]=useState(false)
  const hash=useRef(''), busy=useRef(false)
  useEffect(()=>{
    const controller=new AbortController()
    const {signal}=controller
    busy.current=true;setLoading(true);setError(false)
    void digitalMemoryApi.read(source.id,offset,signal).then(result=>{
      if(signal.aborted)return
      if(hash.current && hash.current!==result.source_hash){setChanged(true);setContent('');setPage(null);return}
      hash.current=result.source_hash;setPage(result);setContent(value=>offset===0?result.content:value+result.content)
      if(offset===0)onCompanion?.(result.companion)
    },()=>{if(!signal.aborted)setError(true)}).finally(()=>{if(!signal.aborted){busy.current=false;setLoading(false)}})
    return()=>controller.abort()
  },[source.id,offset,revision,onCompanion])
  const role=source.role==='user'?t('statistics.user'):source.role==='assistant'?t('channels.assistant'):t(`digitalMemoryView.${source.source_kind}`)
  return <section className="digital-memory-source-record">
    <strong className="digital-memory-source-role">{role}</strong>
    {content && <blockquote>{content}</blockquote>}
    {loading && <p role="status"><Spinner/>{t('digitalMemoryView.loading')}</p>}
    {error && <p role="alert">{t('digitalMemoryView.sourceError')}</p>}
    {changed && <p role="alert">{t('digitalMemoryView.sourceChanged')}</p>}
    {(page?.has_more||error)&&<footer>
      {error && <Button onClick={()=>{if(!busy.current){busy.current=true;setRevision(v=>v+1)}}}>{t('common.retry')}</Button>}
      {page?.has_more && !error && <Button data-memory-next loading={loading} onClick={()=>{if(!busy.current && page.next_offset!==null){busy.current=true;setOffset(page.next_offset)}}}>{t('digitalMemoryView.more')}</Button>}
    </footer>}
  </section>
}

function MemorySourceTimeline({sources,companionOf,onCompanion}:{
  sources:readonly MemorySource[];companionOf?:string;onCompanion?:(companion:MemorySourcePage['companion'])=>void
}){
  const {t,locale}=useI18n()
  const ordered=[...new Map(sources.map(item=>[item.id,item])).values()].sort((left,right)=>
    (toMilliseconds(left.source_time)??Number.MAX_SAFE_INTEGER)-(toMilliseconds(right.source_time)??Number.MAX_SAFE_INTEGER)
    ||Number(left.role!=='user')-Number(right.role!=='user'))
  const entries=ordered.map(item=>({item,time:formatConversationDateTime(item.source_time,null,locale)}))
  return <ol className="digital-memory-source-timeline" role="list" aria-label={t('digitalMemoryView.sourceTitle')}>
    {entries.map(({item,time},index)=>{
      const previous=entries[index-1]
      const projectChanged=previous?.item.project_id!==item.project_id
      const showTime=time&&(projectChanged||time!==previous?.time)
      return <li key={item.id}>
        {(projectChanged||showTime)&&<div className="digital-memory-source-meta">
          {projectChanged&&<span className="digital-memory-source-project">
            <span>{t('digitalMemoryView.project')}</span><strong>{item.project_name||item.project_id}</strong>
          </span>}
          {showTime&&<time dateTime={item.source_time}>{time}</time>}
        </div>}
        <SourceRecord source={item} onCompanion={item.id===companionOf?onCompanion:undefined}/>
      </li>
    })}
  </ol>
}

export default function DigitalPersonMemorySource({source,onClose}:{source:MemorySource;onClose:()=>void}) {
  const [companion,setCompanion]=useState<MemorySourcePage['companion']>()
  const sources=companion?[{...companion,project_name:source.project_name},source]:[source]
  return <MemorySourceDialog sources={sources} companionOf={source.id} onCompanion={setCompanion} onClose={onClose}/>
}

export function MemorySourceDialog({sources,companionOf,onCompanion,onClose,compact=false}:{
  sources:readonly MemorySource[];companionOf?:string;onCompanion?:(companion:MemorySourcePage['companion'])=>void
  onClose:()=>void;compact?:boolean
}) {
  const {t}=useI18n(), ref=useRef<HTMLDivElement>(null), closeRef=useRef<HTMLButtonElement>(null)
  useOverlay(true,onClose,ref,useCompactLayout(),true,closeRef)
  const closeLabel=t(compact?'digitalMemoryView.backToKnowledge':'digitalMemoryView.close')
  return createPortal(<div className={compact?'digital-memory-source-backdrop digital-memory-source-backdrop--compact':'digital-memory-source-backdrop'} onClick={event=>{
    event.stopPropagation()
    if(event.target===event.currentTarget)onClose()
  }}>
    <ResizablePanel ref={ref} role="dialog" aria-modal="true" aria-label={t('digitalMemoryView.sourceTitle')} tabIndex={-1} className="digital-memory-source-panel">
      <header data-dialog-drag-handle>
        <h2>{t('digitalMemoryView.sourceTitle')}</h2>
        <Button ref={closeRef} data-memory-close variant={compact?'icon':undefined} aria-label={closeLabel} title={compact?closeLabel:undefined} onClick={onClose}>
          {compact?<Icon name="x"/>:closeLabel}
        </Button>
      </header>
      <div className="digital-memory-source-body">
        <MemorySourceTimeline sources={sources} companionOf={companionOf} onCompanion={onCompanion}/>
      </div>
    </ResizablePanel>
  </div>,document.body)
}
