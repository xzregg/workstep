import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import type { MemoryKind, MemoryLibraryStats, MemoryViewItem } from '../../api/digitalPerson'
import Button from '../Button'
import Icon from '../Icon'
import { memoryTitle } from './memoryView'

const brainImage = new URL('../../assets/digital-person-memory-brain.png', import.meta.url).href
const kinds:MemoryKind[] = ['preference','experience','fact','event']
const icons = {preference:'bookmark',experience:'book',fact:'file',event:'clock'} as const


/** Lines encode only category membership and shared explicit entities, never inferred relations. */
export default function DigitalPersonMemoryGraph({items,selected,onSelect,onSearch,projectName,totals}:{
 items:MemoryViewItem[];selected:string;onSelect:(id:string)=>void
 onSearch:(query:string)=>void;projectName:string;totals?:MemoryLibraryStats['by_kind']
}) {
 const {t}=useI18n()
 const [zoom,setZoom]=useState(1),[page,setPage]=useState(0)
 const groups=kinds.map(kind=>({kind,items:items.filter(item=>item.kind===kind)}))
 const count=(kind:MemoryKind)=>totals?.[kind]?.toLocaleString()??'—'
 const pages=Math.max(1,...groups.map(g=>Math.ceil(g.items.length/3)))
 useEffect(()=>{
  if(!selected)return
  const group=items.filter(item=>item.kind===items.find(row=>row.id===selected)?.kind)
  const position=group.findIndex(item=>item.id===selected)
  if(position>=0)setPage(Math.floor(position/3))
 },[selected,items])
 const currentPage=Math.min(page,pages-1)
 const nodes=groups.flatMap((group,g)=>group.items.slice(currentPage*3,currentPage*3+3).map((item,i)=>({
  item,g,x:g%2===0?21:79,y:(g<2?22:69)+i*10,
 })))
 const entities=Array.from(new Map(items.flatMap(item=>item.entities.map(entity=>[entity.kind+':'+entity.name,entity] as const))).values())
  .map(entity=>({...entity,count:items.filter(item=>item.entities.some(e=>e.name===entity.name&&e.kind===entity.kind)).length}))
  .sort((a,b)=>Number(b.kind==='person')-Number(a.kind==='person')||b.count-a.count).slice(0,2)
 return <>
  <div className="digital-memory-graph-actions">
   <div className="digital-memory-zoom">
    <Button variant="icon" data-memory-zoom="out" aria-label={t('digitalMemoryView.zoomOut')} disabled={zoom<=.75} onClick={()=>setZoom(v=>v-.25)}><Icon name="minus" size={16}/></Button>
    <span data-memory-zoom-value>{Math.round(zoom*100)}%</span>
    <Button variant="icon" data-memory-zoom="in" aria-label={t('digitalMemoryView.zoomIn')} disabled={zoom>=1.75} onClick={()=>setZoom(v=>v+.25)}><Icon name="plus" size={16}/></Button>
    <Button data-memory-fit onClick={()=>setZoom(1)}><Icon name="maximize-2" size={16}/>{t('digitalMemoryView.fit')}</Button>
   </div>
  </div>
  <div className="digital-memory-graph-scroll" tabIndex={0} role="region" aria-label={t('digitalMemoryView.brain')}>
   <div className="digital-memory-graph-scale" style={{width:`calc(max(100%, 600px) * ${zoom})`}}>
    <div className="digital-memory-diagram">
     <img className="digital-memory-brain" src={brainImage} alt="" draggable={false}/>
     <svg className="digital-memory-connections" viewBox="0 0 1000 760" preserveAspectRatio="none" aria-hidden="true">
      {nodes.map(({item,x,y})=><path key={item.id} data-kind={item.kind} data-selected={selected===item.id} d={`M ${x<50?450:550} 380 C ${x<50?420:580} 380, ${x<50?450:550} ${y*7.6}, ${(x+(x<50?15:-15))*10} ${y*7.6}`}/>)}
      {entities.map((entity,i)=><g key={`${entity.kind}:${entity.name}`}>
       <path className="digital-memory-entity-line" d={`M 500 ${i===0?190:570} L 500 380`}/>
       {nodes.filter(n=>n.item.id===selected&&n.item.entities.some(e=>e.name===entity.name&&e.kind===entity.kind)).map(n=><path className="digital-memory-entity-line" key={n.item.id} d={`M 500 ${i===0?190:570} Q 500 ${n.y*7.6}, ${(n.x+(n.x<50?15:-15))*10} ${n.y*7.6}`}/>)}
      </g>)}
      {entities.map((entity,i)=><text key={`label:${entity.kind}:${entity.name}`} x="500" y={i===0?286:490} textAnchor="middle">{t('digitalMemoryView.entityLink')}</text>)}
     </svg>
     <div className="digital-memory-root"><Icon name="folder" size={20}/><strong>{projectName}</strong></div>
     {entities.map((entity,i)=><Button className={`digital-memory-entity digital-memory-entity-${i}`} key={`${entity.kind}:${entity.name}`} title={t('digitalMemoryView.tagHint')} onClick={()=>onSearch(entity.name)}><Icon name={entity.kind==='person'?'user':'layers'} size={16}/><span>{entity.name}</span></Button>)}
     {groups.map((group,g)=>{
      const visible=nodes.filter(node=>node.g===g).length
      return visible>0&&<div className={`digital-memory-cluster digital-memory-cluster-${g}`} data-kind={group.kind} key={group.kind}>
       <span className="digital-memory-cluster-title"><Icon name={icons[group.kind]} size={16}/>{t(`digitalMemoryView.${group.kind}Short`)} <strong>{count(group.kind)}</strong></span>
      </div>
     })}
     {nodes.map(({item,x,y})=><Button key={item.id} className="digital-memory-node" style={{left:`${x}%`,top:`${y}%`}} data-kind={item.kind} data-raw={!item.interpretation} aria-pressed={selected===item.id} title={item.summary} onClick={()=>onSelect(item.id)}><Icon name={item.interpretation?icons[item.kind]:'file'} size={16}/><strong>{memoryTitle(item)}</strong>{!item.interpretation&&<span className="digital-memory-raw-label">{t('digitalMemoryView.records')}</span>}</Button>)}
    </div>
   </div>
  </div>
  <p className="digital-memory-scroll-hint">{t('digitalMemoryView.graphScrollHint')}</p>
  <div className="digital-memory-graph-footer">
   <div className="digital-memory-legend">{groups.filter(group=>group.items.length).map(({kind})=><span data-kind={kind} key={kind}><i/>{t(`digitalMemoryView.${kind}Short`)} · {count(kind)}</span>)}</div>
   {pages>1&&<div className="digital-memory-pagination"><Button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)} aria-label={t('digitalMemoryView.previous')}><Icon name="chevron-left" size={16}/></Button><span>{t('digitalMemoryView.group',{page:currentPage+1,total:pages})}</span><Button disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)} aria-label={t('digitalMemoryView.next')}><Icon name="chevron-right" size={16}/></Button></div>}
  </div>
  <p className="digital-memory-footnote">{t('digitalMemoryView.graphHint')}</p>
 </>
}
