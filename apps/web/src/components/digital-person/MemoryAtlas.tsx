import {MemorySourceDialog} from './DigitalPersonMemorySource'
import './DigitalPersonMemory.css'
import {memo,useCallback,useEffect,useId,useMemo,useRef,useState,type CSSProperties,type RefObject} from 'react'
import {createPortal} from 'react-dom'
import {atlasRecallLimit,atlasStarLimit,digitalMemoryApi,type AtlasDetail,type AtlasLink,type AtlasStar} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import {toMilliseconds} from '../../utils/datetime'
import {knowledgeSpiral,perimeterOrder,starVariation} from './memoryGalaxy'
import {atlasLinkKey,focusedChainDepth} from './memoryConstellation'
import {useMemoryAtlasMotion} from './useMemoryAtlasMotion'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import {atlasToolEvent,trackAtlasCalls} from './atlasToolEvents'
import './MemoryAtlas.css'

export function AtlasBackdrop() {
  const canvas=useRef<HTMLCanvasElement>(null)
  useEffect(()=>{
    const surface=canvas.current
    if(!surface)return
    const observer=new ResizeObserver(()=>{
      const ctx=surface.getContext('2d')
      if(!ctx)return
      const w=surface.clientWidth,h=surface.clientHeight
      const scale=Math.min(window.devicePixelRatio||1,1.5)
      surface.width=Math.round(w*scale)
      surface.height=Math.round(h*scale)
      ctx.scale(scale,scale)
      let seed=107
      const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)
      for(let i=0;i<w*h/560;i++){
        const x=random()*w,y=random()*h,shine=random()**4
        ctx.fillStyle=i%7===0?'#edced4':'#c7c5ea'
        ctx.globalAlpha=.14+.65*shine
        ctx.beginPath()
        ctx.arc(x,y,.35+.8*shine,0,Math.PI*2)
        ctx.fill()
      }
    })
    observer.observe(surface)
    return ()=>observer.disconnect()
  },[])
  return <canvas className="atlas-backdrop" ref={canvas} aria-hidden="true"/>
}
const day=86_400_000
type AtlasCatalog={items:AtlasStar[];links:AtlasLink[]}

export default memo(function MemoryAtlas({projectId,sessionId,voiceLevel,paused=false,previewTarget}:{projectId:string;sessionId:string;voiceLevel:number;paused?:boolean;previewTarget?:HTMLElement|null}) {
  const {t}=useI18n()
  const canvas=useRef<HTMLCanvasElement>(null)
  const particles=useRef<HTMLCanvasElement>(null)
  const androidWebView=Boolean(window.WorkStepAndroid)||/\bAndroid\b[^)]*;\s*wv\b/i.test(window.navigator.userAgent)
  const sky=useRef<HTMLDivElement>(null)
  const [{items:stars,links},setCatalog]=useState<AtlasCatalog>({items:[],links:[]})
  const known=useRef(new Set<string>())
  const [retrieved,setRetrieved]=useState<{token:string;ids:string[];catalog?:AtlasCatalog} | null>(null)
  const [selected,select]=useState<{star:AtlasStar;recallToken?:string;links?:AtlasLink[]}|null>(null)
  const selection=selected?.star
  const continuation=useRef<{star:AtlasStar;controller:AbortController;checked:Set<string>;loading:boolean}|null>(null)
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading')
  const [revision,reload]=useState(0)
  const selectedButton=useRef<HTMLButtonElement>(null)

  useEffect(()=>{
    if(!selection)return
    const controller=new AbortController()
    continuation.current={star:selection,controller,checked:new Set(),loading:false}
    return ()=>{controller.abort();continuation.current=null}
  },[selection])

  useEffect(()=>{
    const controller=new AbortController()
    setStatus('loading')
    void digitalMemoryApi.atlas(controller.signal).then(catalog=>{
      if(controller.signal.aborted)return
      known.current=new Set(catalog.items.map(star=>star.id))
      setCatalog(catalog)
      setStatus('ready')
    },()=>{
      if(!controller.signal.aborted)setStatus('error')
    })
    return ()=>controller.abort()
  },[revision])

  useEffect(()=>{
    let controller:AbortController|undefined
    const accept=trackAtlasCalls(projectId,sessionId,result=>{
      const ids=result.ids.slice(0,atlasRecallLimit)
      if(!ids.length)return
      controller?.abort()
      const missing=ids.filter(id=>!known.current.has(id))
      setRetrieved({token:result.token,ids})
      if(missing.length||ids.length>1){
        const request=new AbortController()
        controller=request
        void digitalMemoryApi.atlas(request.signal,ids).then(catalog=>{
          if(!request.signal.aborted)setRetrieved({token:result.token,ids,catalog})
        },()=>{})
      }
    })
    const onTool=(event:Event)=>accept((event as CustomEvent).detail)
    window.addEventListener(atlasToolEvent,onTool)
    return ()=>{
      window.removeEventListener(atlasToolEvent,onTool)
      controller?.abort()
    }
  },[projectId,sessionId])

  const dismissSelection=useCallback(()=>select(null),[])
  const setSelectionLinks=useCallback((id:string,links:AtlasLink[])=>{
    select(current=>current?.star.id===id?{...current,links}:current)
  },[])
  const continueFrom=useCallback((root:AtlasStar,tail:AtlasStar)=>{
    const request=continuation.current
    if(!request||request.star!==root||request.loading||request.checked.has(tail.id)
      ||request.checked.size>=focusedChainDepth-1||tail.legacy)return
    request.loading=true
    request.checked.add(tail.id)
    const {signal}=request.controller
    void digitalMemoryApi.atlasDetail(tail,signal).then(({links})=>{
      request.loading=false
      if(signal.aborted||!links?.length)return
      select(current=>{
        if(current?.star!==root||!current.links)return current
        const merged=new Map(current.links.map(link=>[atlasLinkKey(link),link]))
        for(const link of links)merged.set(atlasLinkKey(link),link)
        return merged.size>current.links.length?{...current,links:[...merged.values()]}:current
      })
    },()=>{request.loading=false})
  },[])
  const closeSelection=useCallback(()=>{
    dismissSelection()
    selectedButton.current?.focus({preventScroll:true})
  },[dismissSelection])
  const catalog=useMemo(()=>{
    const byId=new Map(stars.map(star=>[star.id,star]))
    for(const star of retrieved?.catalog?.items??[])byId.set(star.id,star)
    const ordered=[...new Set([...(retrieved?.ids??[]).filter(id=>byId.has(id)),...byId.keys()])].slice(0,atlasStarLimit)
    return {byId,ordered,visible:new Set(ordered)}
  },[stars,retrieved])
  // Keep a preview open if a new recall displaces its star from the catalogue.
  const pinned=selection&&!catalog.visible.has(selection.id)?selection:null
  const layout=useMemo(()=>{
    const byId=pinned?new Map(catalog.byId).set(pinned.id,pinned):catalog.byId
    const orbits=knowledgeSpiral(byId.values())
    const trail=perimeterOrder((retrieved?.ids??[]).flatMap(id=>{
      const orbit=orbits.get(id)
      return orbit?[{id,angle:orbit.angle}]:[]
    }))
    const ranks=new Map(trail.map((id,index)=>[id,index]))
    const step=Math.min(360,2400/Math.max(1,trail.length-1))
    const ordered=pinned?[...catalog.ordered.slice(0,atlasStarLimit-1),pinned.id]:catalog.ordered
    const markerScale=Math.max(.55,Math.min(1,Math.sqrt(120/ordered.length)))
    const visible=new Set(ordered)
    const edges=new Map<string,AtlasLink>()
    for(const link of [...links,...(retrieved?.catalog?.links??[])]){
      if(visible.has(link.from)&&visible.has(link.to))edges.set(atlasLinkKey(link),link)
    }
    const now=Date.now()
    const appearance=ordered.map(id=>{
      const star=byId.get(id)!
      const age=Math.max(0,(now-Date.parse(star.time))/day)
      const recency=Number.isFinite(age)?1/(1+age/30):0
      const weight=.7*Math.max(0,Math.min(1,star.importance))+.3*recency
      const shimmer=.8+.4*starVariation(id)
      return {id,star,weight,shimmer,brightness:weight*shimmer,representative:orbits.get(id)!.representative}
    })
    const flareCount=Math.max(Math.ceil(appearance.length/28),appearance.filter(star=>star.representative).length)
    const flares=new Set([...appearance].sort((a,b)=>Number(b.representative)-Number(a.representative)||b.brightness-a.brightness)
      .slice(0,flareCount).map(({id})=>id))
    return {byId,orbits,ranks,step,markerScale,visible,edges,appearance,flares}
  },[catalog,pinned,links,retrieved])
  const scene=useMemo(()=>{
    const {byId,orbits,ranks,step,markerScale,visible,edges,appearance,flares}=layout
    const buttons=appearance.map(({id,star,weight,shimmer})=>{
      const rank=ranks.get(id)
      const isSelected=selection?.id===id
      const hasFlare=flares.has(id)
      const coreWidth=(1.7+6*weight)*shimmer*orbits.get(id)!.sizeScale*(isSelected?1:markerScale)
      return <button key={id} type="button" ref={isSelected?selectedButton:undefined} className="atlas-star" data-orbit={id} data-kind={star.kind}
        aria-label={[t('digitalMemoryView.atlas'),star.time.slice(0,10),id.slice('knowledge:'.length)].filter(Boolean).join(' · ')}
        aria-pressed={isSelected} data-hit={rank!==undefined} data-flare={hasFlare||undefined}
        style={{zIndex:isSelected?3:rank===undefined?1:2,
          '--atlas-halo-size':hasFlare?`${23+20*(shimmer-1)}px`:undefined} as CSSProperties}
        onClick={()=>{
          if(isSelected){closeSelection();return}
          select({star,recallToken:retrieved?.token})
        }}>
        <i style={{width:coreWidth,opacity:isSelected?1:Math.min(1,(.43+.57*weight)*shimmer)}}/>
        {rank!==undefined&&<i key={retrieved?.token} className="atlas-ignition" style={{animationDelay:rank*step+'ms'}}/>}
      </button>
    })
    const focus=selection?.id
    const recalledEdges=[...edges.values()].filter(link=>ranks.has(link.from)&&ranks.has(link.to))
    const recall=retrieved&&selected?.recallToken!==retrieved.token&&recalledEdges.length
      ?{token:retrieved.token,ranks,step}:undefined
    const focusedEdges=selected?.links?.filter(link=>visible.has(link.from)&&visible.has(link.to))??[...edges.values()]
    return {buttons,orbits,selected:focus,focus:recall?undefined:focus,recall,candidates:recall?recalledEdges:focus?focusedEdges:[],
      continueFrom:selection&&selected?.links?(id:string)=>{
        const tail=byId.get(id)
        if(tail)continueFrom(selection,tail)
      }:undefined}
  },[layout,retrieved,selected,selection,t,closeSelection,continueFrom])
  const camera=useMemoryAtlasMotion(sky,canvas,particles,scene,paused)
  const linkId=useId()
  const preview=selection&&<AtlasPreview key={selection.id} star={selection} starLayer={sky} onClose={closeSelection} onDismiss={dismissSelection} onLinks={setSelectionLinks}/>

  return <div className="memory-atlas" data-dense={scene.buttons.length>120}>
    <div className="memory-atlas-sky" ref={sky}>
      <canvas ref={canvas} aria-hidden="true"/>
      {androidWebView&&<canvas ref={particles} aria-hidden="true" hidden/>}
      <span className="atlas-message-fade" aria-hidden="true"/>
      <svg key={scene.recall?.token??scene.focus??'idle'} className="atlas-links" data-focused={scene.focus?true:undefined} aria-hidden="true">
        {Array.from({length:Math.min(scene.buttons.length-1,scene.candidates.length)},(_,i)=><g key={i} className="atlas-link-segment" visibility="hidden">
          <defs><line id={linkId+'-'+i} pathLength={1}/></defs>
          <use className="atlas-link-halo" href={'#'+linkId+'-'+i}/>
          <use className="atlas-link-core" href={'#'+linkId+'-'+i}/>
        </g>)}
      </svg>
      {voiceLevel>0&&<div className="atlas-voice" aria-hidden="true" style={{opacity:Math.min(.6,voiceLevel)}}>
        {Array.from({length:12},(_,i)=><i key={i} style={{transform:'rotate('+i*137.5+'deg)',animationDelay:(-i*.17)+'s'}}/>)}
      </div>}
      {scene.buttons}
    </div>
    <div className="atlas-camera" data-adjusted={camera.adjusted}>
      <Button variant="icon" size="sm" aria-label={t('digitalMemoryView.atlasZoomOut')} title={t('digitalMemoryView.atlasZoomOut')} onClick={camera.zoomOut}><Icon name="minus"/></Button>
      <Button variant="icon" size="sm" aria-label={t('digitalMemoryView.atlasZoomIn')} title={t('digitalMemoryView.atlasZoomIn')} onClick={camera.zoomIn}><Icon name="plus"/></Button>
      <Button variant="icon" size="sm" aria-label={t('digitalMemoryView.atlasResetView')} title={t('digitalMemoryView.atlasResetView')} onClick={camera.reset}><Icon name="rotate-ccw"/></Button>
    </div>
    <div className="atlas-controls">
      {status==='error'?<Button size="sm" onClick={()=>reload(n=>n+1)}>{t('digitalMemoryView.error')}</Button>:
        !stars.length&&<span role="status">{status==='loading'&&<Spinner/>}{t(status==='loading'?'digitalMemoryView.loading':'digitalMemoryView.noKnowledgeYet')}</span>}
    </div>
    {previewTarget?createPortal(preview,previewTarget):previewTarget===undefined?preview:null}
  </div>
})

function AtlasPreview({star,starLayer,onClose,onDismiss,onLinks}:{
  star:AtlasStar;starLayer:RefObject<HTMLDivElement|null>;onClose:()=>void;onDismiss:()=>void;onLinks:(id:string,links:AtlasLink[])=>void
}) {
  const {t,locale}=useI18n()
  const panel=useRef<HTMLElement>(null)
  const [detail,setDetail]=useState<AtlasDetail|null>(null)
  const [error,setError]=useState(false)
  const [revision,retry]=useState(0)
  const [showSources,setShowSources]=useState(false)
  useEffect(()=>{
    function dismissOutside(event:MouseEvent){
      const target=event.target
      if(!(target instanceof Element)||!panel.current||event.composedPath().includes(panel.current))return
      const starButton=target.closest('.atlas-star')
      if(starButton&&starLayer.current?.contains(starButton))return
      onDismiss()
    }
    document.addEventListener('click',dismissOutside)
    return ()=>document.removeEventListener('click',dismissOutside)
  },[onDismiss,starLayer])
  useEffect(()=>{
    const controller=new AbortController()
    setError(false)
    void digitalMemoryApi.atlasDetail(star,controller.signal).then(value=>{
      if(controller.signal.aborted)return
      setDetail(value)
      if(value.links)onLinks(star.id,value.links)
    },()=>{
      if(!controller.signal.aborted)setError(true)
    })
    return ()=>controller.abort()
  },[star,revision,onLinks])

  const title=t(star.kind?`digitalMemoryView.${star.kind}Short`:'digitalMemoryView.knowledgeContent')
  const closeLabel=t('digitalMemoryView.close')
  const timestamp=toMilliseconds(star.time)
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(star.time)
  const dateLabel=timestamp===null?'':new Intl.DateTimeFormat(locale,{
    year:'numeric',month:'2-digit',day:'2-digit',
    ...(dateOnly?{timeZone:'UTC'}:{hour:'2-digit',minute:'2-digit'}),
  }).format(timestamp)
  return <aside ref={panel} className="atlas-detail" aria-label={title}
    onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose()}}}>
    <header className="atlas-preview-header">
      <div className="atlas-preview-heading">
        <h2>{title}</h2>
        {dateLabel&&<time dateTime={star.time}>{dateLabel}</time>}
      </div>
      <Button className="atlas-preview-close" variant="icon" aria-label={closeLabel} title={closeLabel} onClick={onClose}><Icon name="x"/></Button>
    </header>
    <div className="atlas-preview-content" aria-live="polite">
      {detail?<>
        <p className="atlas-preview-full">{detail.summary}</p>
        {!!detail.sources.length&&<Button data-atlas-source className="atlas-preview-action" size="sm" aria-haspopup="dialog" onClick={event=>{
          event.currentTarget.focus({preventScroll:true})
          setShowSources(true)
        }}>{t('digitalMemoryView.openSource')}</Button>}
      </>:
        error?<Button className="atlas-preview-action" size="sm" onClick={()=>retry(n=>n+1)}>{t('digitalMemoryView.error')}</Button>:
          <span className="atlas-preview-loading" role="status"><Spinner/>{t('digitalMemoryView.loading')}</span>}
    </div>
    {showSources&&detail&&<MemorySourceDialog sources={detail.sources} compact onClose={()=>setShowSources(false)}/>}
  </aside>
}
