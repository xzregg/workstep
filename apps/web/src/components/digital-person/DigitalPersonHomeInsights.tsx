import {useEffect,useRef,useState,type ReactNode} from 'react'
import type {DigitalActivity,DigitalAffectState,DigitalActivityRecords} from '../../api/digitalPerson'
import {digitalRuntimeApi} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import {DIGITAL_ACTIVITY_CHANGED} from './useDigitalActivity'
import DigitalPersonHomeDetails,{type HomeDetailKind} from './DigitalPersonHomeDetails'
import DigitalPersonActivityDrawer from './DigitalPersonActivityDrawer'
import DigitalPersonDelegationDialog from './DigitalPersonDelegationDialog'
import DigitalPersonDelegationTimeline from './DigitalPersonDelegationTimeline'

type Delegation = DigitalActivityRecords['delegations'][number]
const pageSize = 5
const merge = (first: Delegation[], rest: Delegation[]) =>
 [...first, ...rest.filter(row => !first.some(head => head.id === row.id))]

/** Refresh the latest activity together; older pages load when the user scrolls. */
export default function DigitalPersonHomeInsights({active,canControlWake,name,role,state,activity,affect,chatShown,onInspect,atlasAction}:{
 active:boolean;name:string;role?:string;state:string;activity:DigitalActivity|null;affect:DigitalAffectState|null;chatShown:boolean
 atlasAction?:ReactNode
 canControlWake?:boolean
 onInspect:()=>void
}){
 const {t}=useI18n(),[records,setRecords]=useState<DigitalActivityRecords|null>(null)
 const [extra,setExtra]=useState<Delegation[]>([])
 const [loading,setLoading]=useState(false),[pageError,setPageError]=useState(false)
 const request=useRef({epoch:0,pending:false})
 const [viewedResults,setViewedResults]=useState<Record<string,string>>({})
 const firstPage=useRef<DigitalActivityRecords|null>(null)
 const [exhausted,setExhausted]=useState(false)

 useEffect(()=>{
  if(!active)return
  const cycle=request.current
  let alive=true
  const epoch=++cycle.epoch;cycle.pending=false
  firstPage.current=null;setExhausted(false)
  setExtra([]);setLoading(false);setPageError(false)
  const load=async()=>{
   if(cycle.pending||document.hidden)return
   cycle.pending=true
   try{
    const data=await digitalRuntimeApi.records()
    if(alive){
     const previous=firstPage.current;firstPage.current=data
     setExtra(extra=>extra.length
      ?merge(previous?.delegations??[],extra).filter(row=>!data.delegations.some(head=>head.id===row.id))
      :extra)
     if(previous?.delegation_total!==data.delegation_total)setExhausted(false)
     setRecords(data)
    }
   }catch{if(alive&&!firstPage.current)setRecords(null)}finally{if(cycle.epoch===epoch)cycle.pending=false}
  }
  void load();window.addEventListener(DIGITAL_ACTIVITY_CHANGED,load);document.addEventListener('visibilitychange',load)
  const timer=window.setInterval(load,30000)
  return()=>{alive=false;cycle.epoch++;window.clearInterval(timer);window.removeEventListener(DIGITAL_ACTIVITY_CHANGED,load);document.removeEventListener('visibilitychange',load)}
 },[active])
 const [delegation,setDelegation]=useState<DigitalActivity['delegations'][number]|null>(null)
 const [detail,setDetail]=useState<HomeDetailKind|null>(null)
 const inspect=(kind:HomeDetailKind)=>{onInspect();setDetail(kind)}
 const work=merge(records?.delegations??activity?.delegations?.slice(0,pageSize)??[],extra)
 const canLoadMore=!!records&&!exhausted&&work.length<records.delegation_total
 const loadMore=async()=>{
  if(!active||document.hidden||request.current.pending||!canLoadMore)return
  const epoch=request.current.epoch;request.current.pending=true;setLoading(true);setPageError(false)
  try{
   const {delegations}=await digitalRuntimeApi.records(0,work.length,pageSize)
   if(request.current.epoch!==epoch)return
   if(delegations.length<pageSize||delegations.every(row=>work.some(saved=>saved.id===row.id)))setExhausted(true)
   setExtra(previous=>merge(previous,delegations))
  }catch{if(request.current.epoch===epoch)setPageError(true)}finally{
   if(request.current.epoch===epoch){request.current.pending=false;setLoading(false)}
  }
 }
 return <>
  <aside className="digital-home-presence-info" aria-label={t('digitalPerson.selfStats')}>
   <Button variant="ghost" className="digital-home-identity" onClick={()=>inspect('profile')}><strong><Icon name="bot" size={16}/><span title={name}>{name}</span></strong><span>{['thinking','checking'].includes(state)?<Spinner size={14}/>:<Icon name="audio-lines" size={14}/>} {t(state==='checking'?'digitalPerson.homeReflection':`digitalPerson.homeState${state}` as never)}<span>{activity?.level!=null?`Lv.${activity.level}`:'—'}</span></span></Button>
   <Button variant="ghost" className="digital-home-metric digital-home-affinity" onClick={()=>inspect('affinity')} aria-label={t('digitalPerson.affinity')}><strong><Icon name="message-circle-heart" size={16}/>{affect?.affinity??'—'}</strong><span>{t('digitalPerson.affinity')}</span></Button>
   <Button variant="ghost" className="digital-home-metric" onClick={()=>inspect('reflection')} aria-label={t('digitalPerson.homeReflection')}><strong><Icon name="lightbulb" size={16}/>{records?.reflection_count??'—'}{records?.reflection_count_lower_bound?'+':''}</strong><span>{t('digitalPerson.homeReflection')}</span></Button>
   {atlasAction}
  </aside>
  <DigitalPersonActivityDrawer available={active&&!chatShown} onOpen={onInspect}><aside className="digital-home-context" hidden={!active}>
   <header className="digital-home-activity-header"><h2>{t('digitalPerson.homeProactiveActivity')}</h2></header>
   <DigitalPersonDelegationTimeline items={work} viewedResults={viewedResults}
    loading={loading} pageError={pageError} canLoadMore={canLoadMore} onLoadMore={loadMore}
    onOpen={item=>{onInspect();setDelegation(item)}}/>
  </aside></DigitalPersonActivityDrawer>
  {active&&delegation&&<DigitalPersonDelegationDialog key={delegation.id} delegation={work.find(item=>item.id===delegation.id)??delegation} onClose={()=>setDelegation(null)} onResultVisible={status=>setViewedResults(previous=>previous[delegation.id]===status?previous:{...previous,[delegation.id]:status})}/>}
  {active&&detail&&<DigitalPersonHomeDetails key={detail} kind={detail} canControlWake={canControlWake} name={name} role={role} state={state} activity={activity} affect={affect} records={records} onClose={()=>setDetail(null)}/>}
 </>
}
