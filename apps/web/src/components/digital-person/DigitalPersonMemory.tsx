import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { digitalMemoryApi, type MemoryBrowseResult, type MemoryKind, type MemorySource, type MemoryViewItem } from '../../api/digitalPerson'
import Button from '../Button'
import SegmentedControl from '../SegmentedControl'
import Spinner from '../Spinner'
import Icon from '../Icon'
import DigitalPersonMemoryGraph from './DigitalPersonMemoryGraph'
import { memoryClues, memoryTitle as title } from './memoryView'
import DigitalPersonMemorySource from './DigitalPersonMemorySource'
import './DigitalPersonMemory.css'

const kinds = ['all','preference','experience','fact','event'] as const
const outcomes = ['planned','reported','observed','stated','failed','unknown'] as const


export default function DigitalPersonMemory({name}:{name:string;avatar:'robot'|'spark'}) {
  const {t}=useI18n()
  const text=(key:keyof typeof import('../../i18n/locales/zh-CN').zhCN.digitalMemoryView)=>t(`digitalMemoryView.${key}`)
  const [result,setResult]=useState<MemoryBrowseResult|null>(null),[kind,setKind]=useState<MemoryKind|'all'>('all')
  const [query,setQuery]=useState(''),[request,setRequest]=useState({query:'',revision:0})
  const [loading,setLoading]=useState(true),[error,setError]=useState(false)
  const [mode,setMode]=useState<'brain'|'timeline'>('brain'),[selected,setSelected]=useState('')
  const [project,setProject]=useState(''),[page,setPage]=useState(1),[source,setSource]=useState<MemorySource|null>(null)
  const detail=useRef<HTMLElement>(null)
  useEffect(()=>{
    const controller=new AbortController()
    const {signal}=controller
    setLoading(true);setError(false);setSelected('');setSource(null)
    void digitalMemoryApi.browse(request.query,{kind:kind==='all'?'':kind,projectId:project,page,signal}).then(result=>{
      if(signal.aborted)return
      setResult(result)
      if(kind==='all'&&!project&&page===1) {
        setSelected(result.items.find(item=>item.interpretation&&item.kind==='experience')?.id??result.items.find(item=>item.interpretation)?.id??'')
      }
    },()=>{if(!signal.aborted)setError(true)}).finally(()=>{if(!signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[request,kind,project,page])
  const search=(value=query)=>{setQuery(value);setPage(1);setRequest(r=>({query:value.trim(),revision:r.revision+1}))}
  const items=loading||error?[]:result?.items??[]
  const stats=result?.stats
  const projects=result?.projects??[]
  const projectName=projects.find(({id})=>id===project)?.name??text('allProjects')
  const current=items.find(item=>item.id===selected)
  const changeKind=(value:typeof kind)=>{if(value!==kind){setKind(value);setPage(1)}}
  const select=(id:string)=>{setSelected(id);detail.current?.scrollIntoView?.({block:'nearest',behavior:'smooth'})}
  const sharedEntities=(item:MemoryViewItem)=>current?item.entities.filter(e=>current.entities.some(c=>c.kind===e.kind&&c.name===e.name)).length:0
  const currentClues=new Set(current?memoryClues(current):[])
  const related=current?items.filter(item=>item.id!==current.id && memoryClues(item).some(key=>currentClues.has(key))).sort((a,b)=>sharedEntities(b)-sharedEntities(a)).slice(0,6):[]
  const state=(item:MemoryViewItem)=>text(!item.interpretation?'sourceRecord':item.state==='conflict'?'conflict':'derived')
  const date=(value:string)=>value?new Date(value).toLocaleString(): '—'
  const card=(item:MemoryViewItem)=> <Button key={item.id} className="digital-memory-card" aria-pressed={selected===item.id} onClick={()=>select(item.id)}><small>{text(item.interpretation?`${item.kind}Short`:'records')} · {date(item.time)}</small><strong>{title(item)}</strong><small>{[...new Set(item.sources.map(s=>s.project_name))].join('、')}</small></Button>
  return <div className="digital-person-memory" aria-label={t('digitalMemoryView.title',{name})}>
    <header className="digital-memory-overview"><div className="digital-memory-overview-heading settings-heading-row"><h2>{text('viewTitle')}</h2><Button type="button" variant="icon" data-memory-refresh loading={loading} aria-label={text('refresh')} title={text('refresh')} onClick={()=>search()}>{!loading&&<Icon name="refresh"/>}</Button></div>
      <div className="digital-memory-stats" data-memory-stats aria-label={text('progressTitle')}>
        <span><span className="digital-memory-stat-label">{text('organizedKnowledge')}</span> <strong>{stats?.knowledge_count.toLocaleString()??'—'}</strong> <small>{text('unit')}</small></span>
        <span><span className="digital-memory-stat-label">{text('globalIndex')}</span> <strong>{stats?.indexed_count.toLocaleString()??'—'}</strong> <small>{text('unit')}</small></span>
        <span><span className="digital-memory-stat-label">{text('pendingRecords')}</span> <strong>{stats?.pending_count.toLocaleString()??'—'}</strong> <small>{text('unit')}</small></span>
      </div><p>{text('indexHint')}</p>
    </header>
    <div className="digital-person-memory-map" aria-busy={loading}>
      <div className="digital-memory-controls"><form className="digital-memory-toolbar" onSubmit={e=>{e.preventDefault();search()}}>
        <div className="digital-memory-search-group"><input aria-label={text('search')} placeholder={text('search')} maxLength={1000} value={query} onChange={e=>setQuery(e.target.value)}/><Button type="submit" disabled={loading}><Icon name="search" size={16}/>{text('searchButton')}</Button></div>
        <div className="digital-memory-filters" role="group" aria-label={text('type')}><span>{text('type')}</span>{kinds.map(value=><Button key={value} type="button" data-memory-kind={value} aria-pressed={kind===value} onClick={()=>changeKind(value)}>{text(value==='all'?'all':`${value}Short`)}</Button>)}</div>
        <div className="digital-memory-modes"><SegmentedControl ariaLabel={text('brain')} value={mode} options={(['brain','timeline'] as const).map(value=>({value,label:text(value==='brain'?'brainShort':'timelineShort')}))} onChange={setMode}/></div>
        {request.query && <Button type="button" disabled={loading} onClick={()=>search('')}>{text('clear')}</Button>}
      </form></div>
      <div className="digital-memory-layout"><section className="digital-memory-visual" data-memory-mode={mode}>
        <div className="digital-memory-heading"><div><h2>{mode==='brain'?text('explore'):text('timeline')}</h2>{!loading&&!error&&<p>{t('digitalMemoryView.expanded',{count:items.length,total:stats?.knowledge_count.toLocaleString()??'—'})}</p>}</div>
          {projects.length>1&&<select aria-label={text('projectScope')} value={project} onChange={event=>{setProject(event.target.value);setPage(1)}}><option value="">{text('allProjects')}</option>{projects.map(({id,name})=><option key={id} value={id}>{name}</option>)}</select>}
        </div>
        {(page>1||result?.has_next)&&<div className="digital-memory-pagination digital-memory-results-pagination"><Button disabled={loading||page===1} onClick={()=>setPage(p=>p-1)}>{text('previousPage')}</Button><span>{page}</span><Button disabled={loading||error||!result?.has_next} onClick={()=>setPage(p=>p+1)}>{text('nextPage')}</Button></div>}
        {items.length?(mode==='brain'?<DigitalPersonMemoryGraph items={items} selected={selected} onSelect={select} onSearch={search} projectName={projectName} totals={stats?.by_kind}/>:<div className="digital-memory-timeline">{[...items].sort((a,b)=>Date.parse(b.time)-Date.parse(a.time)).map(card)}</div>):<div className="digital-memory-state" role={error?'alert':'status'} data-memory-empty={!loading&&!error?true:undefined}>{loading&&<Spinner/>}{text(loading?'loading':error?'error':'empty')}</div>}
      </section><aside ref={detail} className="digital-memory-detail" aria-label={text('details')}>
        <div className="digital-memory-progress"><h3>{text('progressTitle')}</h3>
          {stats?<><p>{t('digitalMemoryView.processedRecords',{count:stats.processed_count.toLocaleString(),total:stats.indexed_count.toLocaleString()})}</p>
            <div className="digital-memory-progress-bar"><progress aria-label={text('progressTitle')} max={stats.indexed_count||1} value={stats.processed_count}/><strong>{stats.indexed_count?(stats.processed_count/stats.indexed_count*100).toFixed(1):'0.0'}%</strong></div>
            <p>{text('pendingRecords')} <strong>{stats.pending_count.toLocaleString()}</strong> {text('unit')}</p><details><summary>{text('index')}</summary><p>{text('progressHint')}</p></details>
          </>:<p>{loading?text('loading'):text('statsUnavailable')}</p>}
        </div>
        {current?<><div className="digital-memory-summary-row"><p className="digital-memory-detail-summary">{current.summary}</p><span className="digital-memory-tag">{text(`${current.kind}Short`)}</span></div>
          <dl className="digital-memory-key-facts"><dt>{text('project')}</dt><dd>{[...new Set(current.sources.map(s=>s.project_name))].join('、')}</dd>
            <dt>{text('clues')}</dt><dd className="digital-memory-clues">{current.entities.map((e,i)=><Button key={i} disabled={loading} title={text('tagHint')} onClick={()=>search(e.name)}>{e.name}</Button>)}{!current.entities.length&&text('noClues')}</dd>
            <dt>{text('evidence')}</dt><dd>{current.sources.length} {text('unit')}</dd>
          </dl>
          <section><h3>{text('evidence')}</h3>{current.sources.map(s=><div className="digital-memory-source" key={s.id}><span><Icon name="file" size={14}/>{s.project_name} · {text(s.source_kind)}</span><Button data-memory-source onClick={()=>setSource(s)}>{text('openSource')}</Button></div>)}</section>
          {!!related.length&&<section><h3>{text('related')}</h3>{related.slice(0,3).map(item=><Button key={item.id} className="digital-memory-related" onClick={()=>setSelected(item.id)}><Icon name="book" size={16}/><span>{title(item)}</span><Icon name="chevron-right" size={14}/></Button>)}</section>}
          <details className="digital-memory-metadata"><summary>{text('moreDetails')}</summary>
            <dl><dt>{text('state')}</dt><dd>{state(current)}</dd><dt>{text(current.time_is_source?'sourceTime':'time')}</dt><dd>{date(current.time)}</dd>
            {current.interpretation&&<><dt>{text('outcome')}</dt><dd>{text(outcomes.find(v=>v===current.outcome)||'unknown')}</dd></>}</dl>
            {!!current.relations.length&&<><h3>{text('relations')}</h3>{current.relations.map((r,i)=><p key={i}>{r.from} → {r.relation} → {r.to}</p>)}</>}
            <p className="digital-memory-notice">{text(current.interpretation?'interpretationHint':'rawHint')}</p>
          </details>
        </>:<><span className="digital-memory-tag">{text('details')}</span><h2>{text('select')}</h2><p>{text('selectHint')}</p></>}
      </aside></div>
      <div className="digital-memory-status" role="status">{loading?<><Spinner/>{text('loading')}</>:<><Icon name="clock" size={16}/><span>{stats?.latest_knowledge_at?`${text('latestKnowledge')} ${date(stats.latest_knowledge_at)}`:text(stats?'noKnowledgeYet':'statsUnavailable')}</span>{stats&&<span>{t('digitalMemoryView.todayKnowledge',{count:stats.today_count})}</span>}</>}</div>
      <p className="digital-memory-coverage">{text('coverage')}</p>
    </div>
    {source&&<DigitalPersonMemorySource key={source.id} source={source} onClose={()=>setSource(null)}/>}
  </div>
}
