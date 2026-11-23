import {useCallback,useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react'
import {galaxyFrame,galaxyPainter,galaxyZoomMax,galaxyZoomMin,initialGalaxyView,type knowledgeSpiral,type AtlasMarker,type GalaxyView} from './memoryGalaxy'
import {atlasLinkKey,constellationLinks,focusedChainDepth} from './memoryConstellation'
import type {AtlasLink} from '../../api/digitalPerson'

type Point={x:number;y:number}
type Scene={orbits:ReturnType<typeof knowledgeSpiral>;candidates:AtlasLink[];selected?:string;focus?:string;continueFrom?:(id:string)=>void;recall?:{ranks:ReadonlyMap<string,number>;step:number}}
const rotationFrameInterval=1000/24

export function useMemoryAtlasMotion(
  sky:RefObject<HTMLDivElement|null>,canvas:RefObject<HTMLCanvasElement|null>,
  particleCanvas:RefObject<HTMLCanvasElement|null>,scene:Scene,paused:boolean,
) {
  const sceneRef=useRef(scene)
  const pausedRef=useRef(paused)
  const time=useRef(0)
  const resolution=useRef(1)
  const slowFrames=useRef(0)
  const view=useRef({...initialGalaxyView})
  const [adjusted,setAdjusted]=useState(false)
  const requestDraw=useRef<()=>void>(()=>{})
  const findStar=useRef<((point:Point)=>HTMLButtonElement|undefined)|null>(null)
  const painter=useRef<ReturnType<typeof galaxyPainter>|null>(null)
  const previousLinks=useRef(new Set<string>())

  useLayoutEffect(()=>{
    const gpuSurface=particleCanvas.current
    const redraw=()=>requestDraw.current()
    gpuSurface?.addEventListener('webglcontextlost',redraw)
    return ()=>{
      gpuSurface?.removeEventListener('webglcontextlost',redraw)
      painter.current?.dispose()
      painter.current=null
    }
  },[particleCanvas])

  useLayoutEffect(()=>{
    const layer=sky.current,surface=canvas.current
    if(!layer||!surface)return
    const {paint,canBatchStars}=painter.current??=galaxyPainter(surface,particleCanvas.current)
    const androidWebView=Boolean(particleCanvas.current)
    const motion=window.matchMedia('(prefers-reduced-motion: reduce)')
    const colors=new Map<string|undefined,number[]>()
    let activeScene:Scene|undefined
    let blur=6,hitRadius=0
    let stars:Array<ReturnType<typeof readStar>>=[]
    let starsById=new Map<string,ReturnType<typeof readStar>>()
    const markers:AtlasMarker[]=[]
    let lines:ReturnType<typeof readLines>=[]
    const candidateIds=new Set<string>()
    let linked=new Set<string>()
    let endpoints=new Set<string>()
    const positions=new Map<string,Point>()
    let width=layer.clientWidth,height=layer.clientHeight
    let frame:number|null=null
    let lastTick:number|undefined,nextRotationFrame:number|undefined
    let visible=true,dirty=false

    function readStar(button:HTMLButtonElement,current:Scene){
      const id=button.dataset.orbit!
      let marker:AtlasMarker|undefined
      let size=0
      if(androidWebView&&button.getAttribute('aria-pressed')==='false'&&button.dataset.hit==='false'&&!button.hasAttribute('data-flare')){
        const kind=button.dataset.kind
        let color=colors.get(kind)
        if(!color){
          const channels=getComputedStyle(button).color.match(/[\d.]+/g)
          color=channels?.slice(0,3).map(channel=>Number(channel)/255)??[.67,.65,.82]
          colors.set(kind,color)
        }
        const core=button.querySelector('i')!
        size=Number.parseFloat(core.style.width)
        marker={x:0,y:0,diameter:0,blur,rgb:color,alpha:Number(core.style.opacity)}
      }
      return {button,id,position:current.orbits.get(id)!.position,marker,size,priority:Number(button.style.zIndex),
        center:{x:0,y:0},inBounds:button.style.visibility!=='hidden'}
    }

    function readLines(){
      return Array.from(layer!.querySelectorAll<SVGGElement>('.atlas-link-segment'),group=>({
        group,geometry:group.querySelector<SVGLineElement>('line')!,core:group.querySelector<SVGUseElement>('.atlas-link-core')!,
      }))
    }

    function syncScene(current:Scene){
      if(current===activeScene)return
      if(current.orbits!==activeScene?.orbits){
        blur=layer!.closest('.memory-atlas')?.getAttribute('data-dense')==='true'?3:6
        stars=Array.from(layer!.querySelectorAll<HTMLButtonElement>('[data-orbit]'),button=>readStar(button,current))
        hitRadius=(stars[0]?.button.offsetWidth??0)/2
        starsById=new Map(stars.map(star=>[star.id,star]))
        linked=new Set(stars.filter(({button})=>button.hasAttribute('data-linked')).map(({id})=>id))
      }else if(current.selected!==activeScene.selected){
        for(const id of [activeScene.selected,current.selected]){
          const star=id?starsById.get(id):undefined
          if(star)Object.assign(star,readStar(star.button,current))
        }
      }
      lines=readLines()
      candidateIds.clear()
      for(const {from,to} of current.candidates){candidateIds.add(from);candidateIds.add(to)}
      activeScene=current
    }

    function hitTest(point:Point){
      const rect=layer!.getBoundingClientRect()
      const x=(point.x-rect.left)*width/rect.width,y=(point.y-rect.top)*height/rect.height
      let hit:HTMLButtonElement|undefined,priority=0
      // Paint order is z-index first, then the last matching button in DOM order.
      for(let index=stars.length-1;index>=0;index--){
        const star=stars[index]
        if(!star.inBounds||star.priority<=priority)continue
        const dx=star.center.x-x,dy=star.center.y-y
        if(dx*dx+dy*dy<=hitRadius*hitRadius){
          hit=star.button
          priority=star.priority
        }
      }
      return hit
    }
    function moveButton(button:HTMLButtonElement,{x,y}:Point){
      button.style.transform=androidWebView
        ?`translate(${x}px,${y}px) translate(-50%,-50%)`
        :`translate3d(${x}px,${y}px,0) translate(-50%,-50%)`
    }
    function draw(){
      const scene=sceneRef.current
      const sampling=layer!.hasAttribute('data-atlas-sampling')
      const started=sampling?performance.now():0
      syncScene(scene)
      const projection=galaxyFrame(view.current,time.current)
      const batchStars=canBatchStars()
      if(layer!.hasAttribute('data-batched-stars')!==batchStars)layer!.toggleAttribute('data-batched-stars',batchStars)
      findStar.current=batchStars?hitTest:null
      const focused=batchStars?document.activeElement:null
      const zoomScale=Math.sqrt(projection.zoom)
      positions.clear()
      markers.length=0
      for(const star of stars){
        const {button,id,position,marker,size,center}=star
        const point=position(projection)
        const inBounds=point.x>=0&&point.x<=100&&point.y>=0&&point.y<=100
        if(star.inBounds!==inBounds){
          star.inBounds=inBounds
          button.style.visibility=inBounds?'':'hidden'
        }
        if(!inBounds)continue
        center.x=point.x*width/100
        center.y=point.y*height/100
        const scale=point.perspective*zoomScale
        if(batchStars&&marker){
          marker.x=center.x
          marker.y=center.y
          marker.diameter=size*scale
          marker.blur=blur*scale
          markers.push(marker)
          if(button===focused)moveButton(button,center)
        }else{
          moveButton(button,center)
          button.style.setProperty('--atlas-star-scale',String(scale))
        }
        if(candidateIds.has(id))positions.set(id,center)
      }
      const links=scene.candidates.length
        ?constellationLinks(scene.candidates,positions,Math.hypot(width,height)*.28*projection.zoom,previousLinks.current,scene.focus):[]
      let tail=scene.focus
      previousLinks.current.clear()
      endpoints.clear()
      for(const [i,{group,geometry,core}] of lines.entries()){
        const link=links[i]
        if(!link){
          if(core.hasAttribute('data-link')){
            group.setAttribute('visibility','hidden')
            group.removeAttribute('data-recall')
            core.removeAttribute('data-link')
            core.removeAttribute('data-highlighted')
            core.removeAttribute('data-recall')
          }
          continue
        }
        const key=atlasLinkKey(link)
        previousLinks.current.add(key)
        endpoints.add(link.from)
        endpoints.add(link.to)
        let a=positions.get(link.from)!,b=positions.get(link.to)!
        if(tail){
          const forward=tail===link.from
          if(!forward)[a,b]=[b,a]
          tail=forward?link.to:link.from
          const delay=i*100+'ms'
          if(group.style.getPropertyValue('--atlas-link-delay')!==delay)group.style.setProperty('--atlas-link-delay',delay)
        }
        if(scene.recall){
          const from=scene.recall.ranks.get(link.from)!,to=scene.recall.ranks.get(link.to)!
          if(to<from)[a,b]=[b,a]
          const delay=Math.min(from,to)*scene.recall.step+'ms'
          if(group.style.getPropertyValue('--atlas-link-delay')!==delay)group.style.setProperty('--atlas-link-delay',delay)
          if(!group.hasAttribute('data-recall')){
            group.setAttribute('data-recall','true')
            core.setAttribute('data-recall','true')
          }
        }
        geometry.setAttribute('x1',String(a.x))
        geometry.setAttribute('y1',String(a.y))
        geometry.setAttribute('x2',String(b.x))
        geometry.setAttribute('y2',String(b.y))
        if(core.dataset.link!==key)core.dataset.link=key
        if(group.hasAttribute('visibility')){
          core.setAttribute('data-highlighted','true')
          group.removeAttribute('visibility')
        }
      }
      for(const id of linked)if(!endpoints.has(id))starsById.get(id)?.button.removeAttribute('data-linked')
      for(const id of endpoints){
        const {button,marker,center}=starsById.get(id)!
        if(!linked.has(id))button.setAttribute('data-linked','')
        if(batchStars&&marker&&button!==focused)moveButton(button,center)
      }
      ;[linked,endpoints]=[endpoints,linked]
      if(tail&&links.length>0&&links.length<focusedChainDepth)scene.continueFrom?.(tail)
      const updated=sampling?performance.now():0
      paint(projection,width,height,markers,resolution.current)
      if(sampling)layer!.dispatchEvent(new window.CustomEvent('workstep:atlas-profile-frame',{
        detail:{particles:performance.now()-updated,markers:updated-started},
      }))
    }
    const canDraw=()=>visible&&!document.hidden
    const rotating=()=>!pausedRef.current&&!motion.matches
    function schedule(){
      if(frame===null&&canDraw())frame=requestAnimationFrame(tick)
    }
    function invalidate(){
      dirty=true
      schedule()
    }
    function tick(now:number){
      frame=null
      if(!canDraw())return
      let rotationDue=false
      if(rotating()){
        if(lastTick!==undefined){
          const gap=now-lastTick
          time.current+=Math.min(gap,100)/1000
          if(androidWebView&&resolution.current===1){
            slowFrames.current=gap>80?slowFrames.current+1:0
            if(slowFrames.current>=6){
              resolution.current=.75
              dirty=true
            }
          }
        }
        lastTick=now
        nextRotationFrame??=now+rotationFrameInterval
        // Carry the deadline forward to avoid rounding 24 Hz down to 20 on 60 Hz displays.
        const overdue=now-nextRotationFrame+.01
        rotationDue=overdue>=0
        if(rotationDue)nextRotationFrame+=(1+Math.floor(overdue/rotationFrameInterval))*rotationFrameInterval
      }else{
        lastTick=nextRotationFrame=undefined
      }
      if(dirty||rotationDue){
        draw()
        dirty=false
      }
      if(rotating())schedule()
    }
    function resume(){
      if(frame!==null)cancelAnimationFrame(frame)
      frame=null
      lastTick=nextRotationFrame=undefined
      invalidate()
    }
    requestDraw.current=invalidate
    const resize=new ResizeObserver(()=>{
      if(width===layer.clientWidth&&height===layer.clientHeight)return
      width=layer.clientWidth
      height=layer.clientHeight
      invalidate()
    })
    resize.observe(layer)
    const intersection=typeof window.IntersectionObserver==='function'?new window.IntersectionObserver(([entry])=>{
      if(visible===entry.isIntersecting)return
      visible=entry.isIntersecting
      resume()
    }):null
    intersection?.observe(layer)
    motion.addEventListener('change',resume)
    document.addEventListener('visibilitychange',resume)
    if(androidWebView)layer.addEventListener('focusin',invalidate)
    invalidate()
    return ()=>{
      requestDraw.current=()=>{}
      findStar.current=null
      if(frame!==null)cancelAnimationFrame(frame)
      resize.disconnect()
      intersection?.disconnect()
      motion.removeEventListener('change',resume)
      document.removeEventListener('visibilitychange',resume)
      if(androidWebView)layer.removeEventListener('focusin',invalidate)
    }
  },[sky,canvas,particleCanvas])

  useLayoutEffect(()=>{
    sceneRef.current=scene
    pausedRef.current=paused
    requestDraw.current()
  },[scene,paused])

  const updateView=useCallback((next:GalaxyView)=>{
    view.current=next
    const tolerance=1e-6
    setAdjusted(Math.abs(Math.sin((next.yaw-initialGalaxyView.yaw)/2))>tolerance
      ||Math.abs(next.pitch-initialGalaxyView.pitch)>tolerance
      ||Math.abs(next.zoom-initialGalaxyView.zoom)>tolerance)
    requestDraw.current()
  },[])

  const changeZoom=useCallback((factor:number)=>{
    const zoom=Math.max(galaxyZoomMin,Math.min(galaxyZoomMax,view.current.zoom*factor))
    updateView({...view.current,zoom})
  },[updateView])

  useEffect(()=>{
    const layer=sky.current
    if(!layer)return
    const pointers=new Map<number,Point>()
    let origin:Point|undefined,tap:Point|undefined,dragged=false,pinch=0

    function distance(){
      const [a,b]=pointers.values()
      return Math.hypot(a.x-b.x,a.y-b.y)
    }
    function down(event:PointerEvent){
      if(event.button!==0||pointers.size>=2)return
      const point={x:event.clientX,y:event.clientY}
      pointers.set(event.pointerId,point)
      if(pointers.size===1){
        origin=point
        tap=event.pointerType==='touch'?point:undefined
        dragged=false
        return
      }
      if(paused)return
      dragged=true
      pinch=distance()
      for(const id of pointers.keys())layer!.setPointerCapture(id)
    }
    function move(event:PointerEvent){
      const previous=pointers.get(event.pointerId)
      if(!previous||paused)return
      const point={x:event.clientX,y:event.clientY}
      pointers.set(event.pointerId,point)
      if(pointers.size===2){
        const next=distance()
        if(pinch>0&&next>0)changeZoom(next/pinch)
        pinch=next
        return
      }
      if(!dragged){
        if(!origin||Math.hypot(point.x-origin.x,point.y-origin.y)<5)return
        dragged=true
        layer!.setPointerCapture(event.pointerId)
      }
      const yaw=(view.current.yaw+(point.x-previous.x)*.008)%(2*Math.PI)
      const pitch=Math.max(-1.15,Math.min(1.15,view.current.pitch+(point.y-previous.y)*.008))
      updateView({...view.current,yaw,pitch})
    }
    function end(event:PointerEvent){
      if(tap&&pointers.has(event.pointerId))tap={x:event.clientX,y:event.clientY}
      pointers.delete(event.pointerId)
    }
    function click(event:MouseEvent){
      if(event.detail===0)return
      if(dragged){event.preventDefault();event.stopPropagation();return}
      if(!findStar.current)return
      // WebView can move the resulting click toward a different native button.
      const button=findStar.current(tap??{x:event.clientX,y:event.clientY})
      tap=undefined
      const target=event.target instanceof Element?event.target.closest('.atlas-star')??undefined:undefined
      if(button===target)return
      event.preventDefault()
      event.stopPropagation()
      if(button)button.click()
      // A stale native target should still behave like a background click.
      else layer!.click()
    }
    function wheel(event:WheelEvent){
      if(paused||event.ctrlKey||!event.deltaY)return
      event.preventDefault()
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?layer!.clientHeight:1)
      changeZoom(Math.exp(Math.max(-.3,Math.min(.3,-delta*.002))))
    }
    layer.addEventListener('pointerdown',down)
    window.addEventListener('pointermove',move)
    window.addEventListener('pointerup',end)
    window.addEventListener('pointercancel',end)
    layer.addEventListener('click',click,true)
    layer.addEventListener('wheel',wheel,{passive:false})
    return ()=>{
      layer.removeEventListener('pointerdown',down)
      window.removeEventListener('pointermove',move)
      window.removeEventListener('pointerup',end)
      window.removeEventListener('pointercancel',end)
      layer.removeEventListener('click',click,true)
      layer.removeEventListener('wheel',wheel)
    }
  },[sky,paused,changeZoom,updateView])

  return {
    adjusted,
    zoomIn:()=>changeZoom(1.2),
    zoomOut:()=>changeZoom(1/1.2),
    reset:()=>{previousLinks.current.clear();updateView({...initialGalaxyView})},
  }
}
