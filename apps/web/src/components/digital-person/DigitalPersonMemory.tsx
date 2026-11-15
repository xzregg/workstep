import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { digitalMemoryApi, type MemoryKind, type MemorySource, type MemoryViewItem } from '../../api/digitalPerson'
import Button from '../Button'
import Spinner from '../Spinner'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import DigitalPersonMemorySource from './DigitalPersonMemorySource'
import './DigitalPersonMemory.css'

const brainImage = new URL('../../assets/digital-person-memory-brain.png', import.meta.url).href
const kinds = ['all','preference','experience','fact','event'] as const
const entityKeys = {person:'person',event:'entityEvent',object:'object',place:'place',time:'entityTime'} as const
const outcomes = ['planned','reported','observed','stated','failed','unknown'] as const
const title = (item:MemoryViewItem) => item.summary.split(/[。！？\n]/)[0].replace(/\s+/g,' ').slice(0,64)

export default function DigitalPersonMemory({name,avatar}:{name:string;avatar:'robot'|'spark'}) {
  const {t}=useI18n()
  const text=(key:keyof typeof import('../../i18n/locales/zh-CN').zhCN.digitalMemoryView)=>t(`digitalMemoryView.${key}`)
  const [items,setItems]=useState<MemoryViewItem[]>([]),[kind,setKind]=useState<MemoryKind|'all'>('all')
  const [query,setQuery]=useState(''),[request,setRequest]=useState({query:'',revision:0})
  const [loading,setLoading]=useState(true),[error,setError]=useState(false)
  const [mode,setMode]=useState<'brain'|'timeline'>('brain'),[selected,setSelected]=useState('')
  const [group,setGroup]=useState(0),[source,setSource]=useState<MemorySource|null>(null)
  const busy=useRef(false),detail=useRef<HTMLElement>(null)
  useEffect(()=>{
    let live=true
    busy.current=true;setLoading(true);setError(false);setItems([]);setSelected('');setGroup(0);setSource(null)
    void digitalMemoryApi.browse(request.query).then(result=>{if(live)setItems(result.items)},()=>{if(live)setError(true)}).finally(()=>{if(live){busy.current=false;setLoading(false)}})
    return()=>{live=false}
  },[request])
  const search=(value=query)=>{if(busy.current)return;busy.current=true;setQuery(value);setKind('all');setRequest(r=>({query:value.trim(),revision:r.revision+1}))}
  const shown=items.filter(item=>kind==='all'||item.kind===kind)
  const current=shown.find(item=>item.id===selected)
  const pages=Math.max(1,Math.ceil(shown.length/6)), visible=shown.slice(group*6,group*6+6)
  const changeKind=(value:typeof kind)=>{setKind(value);setGroup(0);setSelected('')}
  const select=(id:string)=>{setSelected(id);const i=shown.findIndex(item=>item.id===id);if(i>=0)setGroup(Math.floor(i/6));detail.current?.scrollIntoView?.({block:'nearest',behavior:'smooth'})}
  const related=current?items.filter(item=>item.id!==current.id && (item.sources.some(s=>current.sources.some(c=>c.id===s.id)) || item.entities.some(e=>current.entities.some(c=>c.kind===e.kind&&c.name===e.name)))).slice(0,6):[]
  const state=(item:MemoryViewItem)=>text(!item.interpretation?'sourceRecord':item.state==='conflict'?'conflict':'derived')
  const date=(value:string)=>value?new Date(value).toLocaleString(): '—'
  const card=(item:MemoryViewItem)=> <Button key={item.id} className="digital-memory-card" aria-pressed={selected===item.id} onClick={()=>select(item.id)}><small>{text(item.kind)} · {date(item.time)}</small><strong>{title(item)}</strong><small>{[...new Set(item.sources.map(s=>s.project_name))].join('、')}</small></Button>
  return <div className="digital-person-memory">
    <p className="digital-memory-intro">{text('intro')}</p>
    <div className="digital-person-memory-map" aria-busy={loading}>
      <form className="digital-memory-toolbar" onSubmit={e=>{e.preventDefault();search()}}>
        <input aria-label={text('search')} placeholder={text('search')} maxLength={1000} value={query} onChange={e=>setQuery(e.target.value)}/>
        <Button type="submit" disabled={loading}>{text('searchButton')}</Button>
        <div className="digital-memory-modes" role="group" aria-label={text('brain')}>{(['brain','timeline'] as const).map(value=><Button type="button" key={value} data-memory-mode={value} aria-pressed={mode===value} onClick={()=>setMode(value)}>{text(value)}</Button>)}</div>
        <Button type="button" data-memory-refresh loading={loading} onClick={()=>search()}>{text('refresh')}</Button>
        {request.query && <Button type="button" disabled={loading} onClick={()=>search('')}>{text('clear')}</Button>}
      </form>
      <div className="digital-memory-filters" role="group" aria-label={text('type')}><span>{text('type')}</span>{kinds.map(value=><Button key={value} data-memory-kind={value} aria-pressed={kind===value} onClick={()=>changeKind(value)}>{text(value)}</Button>)}</div>
      {error && <p className="digital-memory-error" role="alert">{text('error')}</p>}
      <div className="digital-memory-layout"><section className="digital-memory-visual">
        <div className="digital-memory-heading"><div><h2>{mode==='brain'?t('digitalMemoryView.title',{name}):text('timeline')}</h2><p>{text('hint')}</p></div><div className="digital-memory-person"><DigitalPersonAvatar avatar={avatar}/><span>{t('digitalMemoryView.count',{count:shown.length})}</span></div></div>
        {mode==='brain'?<><div className="digital-memory-diagram" role="group" aria-label={text('brain')}>
          <img className="digital-memory-brain" src={brainImage} alt=""/>
          {visible.map((item,i)=><Button key={item.id} className={`digital-memory-node digital-memory-slot-${i}`} data-kind={item.kind} aria-pressed={selected===item.id} onClick={()=>select(item.id)}><span>{text(item.kind)}</span><strong>{title(item)}</strong></Button>)}
        </div>{shown.length>6&&<div className="digital-memory-pagination"><Button disabled={group===0} onClick={()=>setGroup(v=>v-1)}>{text('previous')}</Button><span>{t('digitalMemoryView.group',{page:group+1,total:pages})}</span><Button disabled={group+1>=pages} onClick={()=>setGroup(v=>v+1)}>{text('next')}</Button></div>}</>:<div className="digital-memory-timeline">{[...shown].sort((a,b)=>Date.parse(b.time)-Date.parse(a.time)).map(card)}</div>}
        <p className="digital-memory-footnote">{text('metaphor')}</p>
      </section><aside ref={detail} className="digital-memory-detail" aria-label={text('details')}>
        {current?<><span className="digital-memory-tag">{text(current.kind)}</span><h2>{title(current)}</h2><p>{current.summary}</p>
          <dl><dt>{text('state')}</dt><dd>{state(current)}</dd><dt>{text(current.time_is_source?'sourceTime':'time')}</dt><dd>{date(current.time)}</dd><dt>{text('project')}</dt><dd>{[...new Set(current.sources.map(s=>s.project_name))].join('、')}</dd>
          {current.interpretation&&<><dt>{text('outcome')}</dt><dd>{text(outcomes.find(v=>v===current.outcome)||'unknown')}</dd></>}</dl>
          <h3>{text('clues')}</h3><div className="digital-memory-clues">{current.entities.map((e,i)=><Button key={i} disabled={loading} title={text('tagHint')} onClick={()=>search(e.name)}>{text(entityKeys[e.kind])} · {e.name}</Button>)}</div>{!current.entities.length&&<p>{text('noClues')}</p>}
          {!!current.relations.length&&<section><h3>{text('relations')}</h3>{current.relations.map((r,i)=><p key={i}>{r.from} → {r.relation} → {r.to}</p>)}</section>}
          <section><h3>{text('evidence')}</h3>{current.sources.map(s=><div className="digital-memory-source" key={s.id}><span>{s.project_name} · {text(s.source_kind)} · {s.role}</span><Button data-memory-source onClick={()=>setSource(s)}>{text('openSource')}</Button></div>)}</section>
          {!!related.length&&<section><h3>{text('related')}</h3><p>{text('relatedHint')}</p>{related.map(item=><Button key={item.id} className="digital-memory-related" onClick={()=>{setKind('all');setSelected(item.id);setGroup(Math.floor(items.indexOf(item)/6))}}>{title(item)} →</Button>)}</section>}
          <p className="digital-memory-notice">{text(current.interpretation?'interpretationHint':'rawHint')}</p>
        </>:<><span className="digital-memory-tag">{text('details')}</span><h2>{text('select')}</h2><p>{text('selectHint')}</p></>}
      </aside></div>
      {!loading&&!error&&!shown.length&&<p className="digital-memory-empty" data-memory-empty>{text('empty')}</p>}
      <div className="digital-memory-status" role="status">{loading?<><Spinner/>{text('loading')}</>:text('coverage')}</div>
    </div>
    {source&&<DigitalPersonMemorySource key={source.id} source={source} onClose={()=>setSource(null)}/>}
  </div>
}
