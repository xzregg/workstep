import DigitalPersonMemorySource from './DigitalPersonMemorySource'
import './DigitalPersonMemory.css'
import {memo,useCallback,useEffect,useId,useMemo,useRef,useState,type CSSProperties} from 'react'
import {atlasRecallLimit,atlasStarLimit,digitalMemoryApi,type AtlasDetail,type AtlasLink,type AtlasStar,type MemorySource} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import {perimeterOrder,starVariation} from './memoryGalaxy'
import {atlasLinkKey} from './memoryConstellation'
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

export default memo(function MemoryAtlas({projectId,sessionId,voiceLevel,paused=false}:{projectId:string;sessionId:string;voiceLevel:number;paused?:boolean}) {
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
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading')
  const [revision,reload]=useState(0)
  const selectedButton=useRef<HTMLButtonElement>(null)

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
  const closeSelection=useCallback(()=>{
    dismissSelection()
    selectedButton.current?.focus({preventScroll:true})
  },[dismissSelection])
  const scene=useMemo(()=>{
    const byId=new Map(stars.map(star=>[star.id,star]))
    for(const star of retrieved?.catalog?.items??[])byId.set(star.id,star)
    if(selection)byId.set(selection.id,selection)
    const trail=perimeterOrder((retrieved?.ids??[]).filter(id=>byId.has(id)))
    const ranks=new Map(trail.map((id,index)=>[id,index]))
    const step=Math.min(360,2400/Math.max(1,trail.length-1))
    const ordered=[...new Set([...(selection?[selection.id]:[]),...trail,...byId.keys()])].slice(0,atlasStarLimit)
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
      return {id,star,weight,shimmer,brightness:weight*shimmer}
    })
    const flares=new Set([...appearance].sort((a,b)=>b.brightness-a.brightness)
      .slice(0,Math.ceil(appearance.length/28)).map(({id})=>id))
    const buttons=appearance.map(({id,star,weight,shimmer})=>{
      const rank=ranks.get(id)
      const isSelected=selection?.id===id
      const hasFlare=flares.has(id)
      return <button key={id} type="button" ref={isSelected?selectedButton:undefined} className="atlas-star" data-orbit={id} data-kind={star.kind}
        aria-label={[t('digitalMemoryView.atlas'),star.time.slice(0,10),id.slice('knowledge:'.length)].filter(Boolean).join(' · ')}
        aria-pressed={isSelected} data-hit={rank!==undefined} data-flare={hasFlare||undefined}
        style={{zIndex:isSelected?3:rank===undefined?1:2,
          '--atlas-halo-size':hasFlare?`${33+40*(shimmer-1)}px`:undefined} as CSSProperties}
        onClick={()=>{
          if(isSelected){closeSelection();return}
          select({star,recallToken:retrieved?.token})
        }}>
        <i style={{width:(1.7+6*weight)*shimmer*(isSelected?1:markerScale),opacity:isSelected?1:Math.min(1,(.43+.57*weight)*shimmer)}}/>
        {rank!==undefined&&<i key={retrieved?.token} className="atlas-ignition" style={{animationDelay:rank*step+'ms'}}/>}
      </button>
    })
    const focus=selection?.id
    const recalledEdges=[...edges.values()].filter(link=>ranks.has(link.from)&&ranks.has(link.to))
    const recall=retrieved&&selected?.recallToken!==retrieved.token&&recalledEdges.length
      ?{token:retrieved.token,ranks,step}:undefined
    const focusedEdges=selected?.links?.filter(link=>visible.has(link.from)&&visible.has(link.to))??[...edges.values()]
    return {buttons,focus:recall?undefined:focus,recall,candidates:recall?recalledEdges:focus?focusedEdges:[]}
  },[stars,links,retrieved,selected,selection,t,closeSelection])
  const camera=useMemoryAtlasMotion(sky,canvas,particles,scene,paused)
  const linkId=useId()

  return <div className="memory-atlas" data-dense={scene.buttons.length>120}>
    <div className="memory-atlas-sky" ref={sky}>
      <canvas ref={canvas} aria-hidden="true"/>
      {androidWebView&&<canvas ref={particles} aria-hidden="true" hidden/>}
      <span className="atlas-message-fade" aria-hidden="true"/>
      <svg key={scene.recall?.token??'manual'} className="atlas-links" aria-hidden="true">
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
    {selection&&<AtlasPreview key={selection.id} star={selection} onClose={closeSelection} onDismiss={dismissSelection} onLinks={setSelectionLinks}/>}
  </div>
})

function AtlasPreview({star,onClose,onDismiss,onLinks}:{
  star:AtlasStar;onClose:()=>void;onDismiss:()=>void;onLinks:(id:string,links:AtlasLink[])=>void
}) {
  const {t}=useI18n()
  const panel=useRef<HTMLElement>(null)
  const [detail,setDetail]=useState<AtlasDetail|null>(null)
  const [error,setError]=useState(false)
  const [revision,retry]=useState(0)
  const [source,setSource]=useState<MemorySource|null>(null)
  useEffect(()=>{
    if(source)return
    function dismissOutside(event:MouseEvent){
      const target=event.target
      if(!(target instanceof Element)||!panel.current||panel.current.contains(target))return
      const starButton=target.closest('.atlas-star')
      if(starButton&&panel.current.parentElement?.contains(starButton))return
      onDismiss()
    }
    document.addEventListener('click',dismissOutside)
    return ()=>document.removeEventListener('click',dismissOutside)
  },[onDismiss,source])
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

  const latest=detail?.sources[0]
  return <aside ref={panel} className="atlas-detail" aria-label={t('digitalMemoryView.details')}>
    <div className="atlas-preview-content" aria-live="polite">
      {detail?<p className="atlas-preview-summary" title={detail.summary}>{detail.summary}</p>:
        error?<Button className="atlas-preview-action" size="sm" onClick={()=>retry(n=>n+1)}>{t('digitalMemoryView.error')}</Button>:
          <span className="atlas-preview-loading" role="status"><Spinner/>{t('digitalMemoryView.loading')}</span>}
      {latest&&<Button className="atlas-preview-action" size="sm" onClick={()=>setSource(latest)}>{t('digitalMemoryView.openSource')}</Button>}
    </div>
    <Button className="atlas-preview-close" variant="icon" aria-label={t('digitalMemoryView.close')} onClick={onClose}><Icon name="x"/></Button>
    {source&&<DigitalPersonMemorySource key={source.id} source={source} onClose={()=>setSource(null)}/>}
  </aside>
}
