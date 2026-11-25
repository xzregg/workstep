import {atlasParticleBatch} from './atlasParticleBatch'
import {atlasStarLimit,type AtlasStar,type MemoryKind} from '../../api/digitalPerson'

export type AtlasMarker={x:number;y:number;diameter:number;blur:number;rgb:number[];alpha:number}

// Project all nine inclined belts and their knowledge stars in the same coordinate space.
const radii = [.08, .15, .27, .39, .54, .69, .91, 1.12, 1.37]
export const initialGalaxyView={yaw:0,pitch:.48,zoom:1}
export const galaxyZoomMin=.65, galaxyZoomMax=2
export type GalaxyView=typeof initialGalaxyView
const rollCos=Math.cos(.29),rollSin=Math.sin(.29)
const turn=2*Math.PI
const week=7*86_400_000
const armCount=4

function armAngle(radius:number,arm:number) {
  return -.85 + 3.55*Math.log1p(radius*3) + arm*turn/armCount
}

export function galaxyFrame(view:GalaxyView,seconds:number) {
  const pitchSin=Math.sin(view.pitch),pitchCos=Math.cos(view.pitch)
  const belts=[...radii,0].map((radius,belt)=>{
    // Rotate the disc against the outward curve so the tips trail behind.
    const angle=view.yaw-seconds*(radius?.105:.12)
    return {
      sin:Math.sin(angle),cos:Math.cos(angle),
      incline:radius?.09*Math.sin(belt*.87):0,offset:.045*Math.cos((radius?belt:0)*.7),
    }
  })
  function project(x:number,z:number,height:number,belt:number,point={x:0,y:0,perspective:0}) {
    const {sin,cos,incline,offset}=belts[belt]
    const rotatedX=x*cos-z*sin,rotatedZ=x*sin+z*cos
    const y=height+z*incline+offset
    const depth=y*pitchSin+rotatedZ*pitchCos
    const tilt=y*pitchCos-rotatedZ*pitchSin
    const perspective=3.8/(3.8-depth)
    const scale=31*view.zoom*perspective
    point.x=50+scale*(rotatedX*rollCos-tilt*rollSin)
    point.y=50-scale*1.35*(rotatedX*rollSin+tilt*rollCos)
    point.perspective=perspective
    return point
  }
  return {project,belts,pitchSin,pitchCos,yaw:view.yaw,seconds,zoom:view.zoom}
}
type GalaxyFrame=ReturnType<typeof galaxyFrame>
function starHash(id:string) {
  let hash=2166136261
  for(const char of id) hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0
  return hash
}

export function starVariation(id:string) {
  return generator(starHash(id)^0x9e3779b9)()
}

function starOrbit(id:string,radius:number,arm:number,spread:number) {
  const random=generator(starHash(id))
  const belt=radii.findIndex((radiusAtBelt,index)=>index===radii.length-1||radius<=(radiusAtBelt+radii[index+1])/2)
  const angle=armAngle(radius,arm)+spread*(.35+.07*radius)
  const height=(random()+random()-1)*.13
  const x=radius*Math.cos(angle),z=radius*Math.sin(angle)
  return {angle:angle%turn,position:(frame:GalaxyFrame)=>frame.project(x,z,height,belt)}
}

export function knowledgeSpiral(stars:Iterable<Pick<AtlasStar,'id'|'time'|'kind'>>) {
  const counts=new Map<MemoryKind,number>()
  const ordered=Array.from(stars,({id,time,kind})=>{
    if(kind)counts.set(kind,(counts.get(kind)??0)+1)
    const timestamp=Date.parse(time)
    return {id,time:Number.isFinite(timestamp)?timestamp:-Infinity,kind}
  }).sort((a,b)=>b.time-a.time||a.id.localeCompare(b.id))
  const dated=ordered.filter(({time})=>Number.isFinite(time))
  const latest=dated[0]?.time??0
  const timeSpan=Math.log1p((latest-(dated.at(-1)?.time??latest))/week)
  const largest=Math.max(0,...counts.values())
  const rareKinds=new Set([...counts].filter(([,count])=>count<largest&&count<=Math.max(1,largest/4)).map(([kind])=>kind))
  const unrepresented=new Set(rareKinds)
  const representatives=new Set<string>()
  for(const {id,kind} of dated){
    if(kind&&unrepresented.delete(kind))representatives.add(id)
  }
  const nearCore=new Set(representatives)
  if(dated[0])nearCore.add(dated[0].id)
  // Keep the newest star and one dated representative per rare kind near the core.
  ordered.sort((a,b)=>Number(nearCore.has(b.id))-Number(nearCore.has(a.id)))
  const inner=radii[1],outer=radii[radii.length-1]
  const armRanks=Array<number>(armCount).fill(0)
  const armOrder=Array.from({length:armCount},(_,arm)=>arm)
  return new Map(ordered.map(({id,time,kind},index)=>{
    const rank=index/Math.max(1,ordered.length-1)
    // Keep batches with identical timestamps moving along the arms.
    const elapsed=Number.isFinite(time)?(timeSpan?Math.log1p((latest-time)/week)/timeSpan:rank):1
    const progress=.78*rank+.22*(nearCore.has(id)?0:elapsed)
    const representative=representatives.has(id)
    const coreClearance=representative&&index>0?.1:0
    const radius=inner+(outer-inner)*progress**.82+coreClearance
    const slot=index%armCount
    // Give each short stretch of the timeline one star per arm in a seeded order.
    if(slot===0){
      const random=generator(starHash(id))
      for(let i=armCount-1;i>0;i--){
        const j=Math.floor(random()*(i+1))
        ;[armOrder[i],armOrder[j]]=[armOrder[j],armOrder[i]]
      }
    }
    const arm=armOrder[slot]
    // A golden-ratio sequence spaces neighbours across the width of each arm.
    const spread=2*((.5+armRanks[arm]++*.61803398875)%1)-1
    const orbit=starOrbit(id,radius,arm,spread)
    const rarityBoost=kind&&rareKinds.has(kind)?.15:0
    const sizeScale=Math.min(2,.5+1.5*(1-progress)**2+rarityBoost)
    return [id,{...orbit,representative,sizeScale}]
  }))
}

// Open the chain at the widest empty sector of the disc.
export function perimeterOrder(stars:Array<{id:string;angle:number}>) {
  const points=[...stars].sort((a,b)=>a.angle-b.angle)
  let gap=-1,start=0
  for(let i=0;i<points.length;i++){
    const next=(i+1)%points.length
    const distance=points[next].angle-points[i].angle+(next===0?2*Math.PI:0)
    if(distance>gap){gap=distance;start=next}
  }
  return [...points.slice(start),...points.slice(0,start)].map(p=>p.id)
}
function generator(seed:number) {
  return ()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)
}

function glowSprite(document:Document,color:string) {
  const sprite=document.createElement('canvas')
  sprite.width=sprite.height=96
  const ctx=sprite.getContext('2d')
  if(!ctx)return sprite
  const glow=ctx.createRadialGradient(48,48,0,48,48,48)
  glow.addColorStop(0,color+'b0')
  glow.addColorStop(.24,color+'46')
  glow.addColorStop(.57,color+'17')
  glow.addColorStop(1,color+'00')
  ctx.fillStyle=glow
  ctx.fillRect(0,0,96,96)
  return sprite
}

export function galaxyPainter(canvas:HTMLCanvasElement,particleCanvas:HTMLCanvasElement|null) {
  const ctx=canvas.getContext('2d')
  if(!ctx)return {paint:()=>{},canBatchStars:()=>false,dispose:()=>{}}
  const dustLayer=canvas.ownerDocument.createElement('canvas')
  const dustContext=dustLayer.getContext('2d')
  const random=generator(781)
  const dust=Array.from({length:950},()=>({x:random(),y:random(),size:.4+random(),alpha:.09+.45*random()}))
  const foreground=Array.from({length:42},()=>({x:random(),y:random(),size:.8+1.25*random(),alpha:.16+.35*random()}))
  // Keep the geometry seeded, and group particles to reduce paint state changes.
  const colors=['#adc9f6','#b0a0e6','#e8a9cb','#ffefd9']
  const rgb=colors.map(color=>[1,3,5].map(channel=>parseInt(color.slice(channel,channel+2),16)/255))
  const particles=colors.map(()=>Array.from({length:8},()=>[] as Array<{x:number;z:number;height:number;belt:number;size:number}>))
  const glows=[
    {belt:9,angle:0,radius:0,size:.68,color:'#f5dbff',alpha:1},
    {belt:9,angle:0,radius:0,size:.23,color:'#fff4e5',alpha:1},
    {belt:8,angle:armAngle(1.29,0),radius:1.29,size:.7,color:'#769aca',alpha:.33},
    {belt:7,angle:armAngle(1.02,1),radius:1.02,size:.64,color:'#a27aba',alpha:.42},
    {belt:6,angle:armAngle(.89,2),radius:.89,size:.51,color:'#c291bc',alpha:.42},
    {belt:7,angle:armAngle(1.12,3),radius:1.12,size:.56,color:'#a7a7c2',alpha:.33},
  ].map(({belt,angle,radius,size,color,alpha})=>({
    belt,x:Math.cos(angle)*radius,z:Math.sin(angle)*radius,size,alpha,
    sprite:glowSprite(canvas.ownerDocument,color),
  }))
  const fieldRadii=[...radii,0]
  fieldRadii.forEach((radius,belt)=>{
    const core=belt===radii.length
    for(let i=0;i<(core?1500:1350);i++){
      const r=core?.28*random()**1.85:Math.max(.025,radius+(random()+random()+random()-1.5)*(.13+.015*belt))
      const inArm=!core&&random()<.88
      const a=inArm?armAngle(r,Math.floor(random()*armCount))+(random()+random()+random()-1.5)*.34:random()*turn
      const height=core?r*(random()-.5):(random()+random()-1)*.12
      const size=core?.43+1.05*random():.28+1.23*random()**3
      const alpha=core?.42+.57*random():(inArm?.13+.72*random()**2:.05+.17*random())
      const tint=random()
      const color=core?3:tint<.12?2:tint<.48?1:0
      particles[color][Math.min(7,Math.floor(alpha*8))].push({
        x:r*Math.cos(a),z:r*Math.sin(a),height,belt,size,
      })
    }
  })
  const orbitData=new Float32Array(fieldRadii.length*4)
  const discData=particleCanvas?new Float32Array((radii.length*1350+1500)*9):null
  if(discData){
    let index=0
    for(const [color,groups] of particles.entries()){
      const [red,green,blue]=rgb[color]
      for(const [level,group] of groups.entries()){
        for(const p of group){
          discData[index++]=p.x
          discData[index++]=p.z
          discData[index++]=p.height
          discData[index++]=red
          discData[index++]=green
          discData[index++]=blue
          discData[index++]=(level+.5)/8
          discData[index++]=p.belt
          discData[index++]=p.size
        }
      }
    }
  }
  const batch=particleCanvas&&discData?atlasParticleBatch(particleCanvas,discData,foreground.length+atlasStarLimit):null
  let previousYaw:number|undefined
  let cachedYaw:number|undefined
  const point={x:0,y:0,perspective:0}
  const offset=(x:number,travel:number)=>((x+travel)%1+1)%1
  function paintDust(target:CanvasRenderingContext2D,w:number,h:number,unit:number,yaw:number){
    target.fillStyle='#e8ddee'
    const travel=yaw*.025
    for(const p of dust){
      target.globalAlpha=p.alpha
      target.fillRect(offset(p.x,travel)*w,p.y*h,p.size*unit,p.size*unit)
    }
  }
  const paint=(frame:GalaxyFrame,width:number,height:number,markers:readonly AtlasMarker[],resolution:number)=>{
    const ratio=particleCanvas
      ? Math.min(window.devicePixelRatio||1,1.1,600/Math.max(width,height))*resolution
      : Math.min(window.devicePixelRatio||1,1.5,900/Math.max(width,height))
    const w=Math.round(width*ratio),h=Math.round(height*ratio)
    if(!w||!h)return
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
    ctx.clearRect(0,0,w,h)
    const shortestSide=Math.min(w,h)
    const unit=shortestSide/360
    const zoomScale=Math.sqrt(frame.zoom)
    const gpu=batch?.available()?batch:null
    if(particleCanvas&&particleCanvas.hidden===Boolean(gpu))particleCanvas.hidden=!gpu
    const renderer=gpu?'webgl2':'canvas2d'
    if(canvas.dataset.atlasRenderer!==renderer)canvas.dataset.atlasRenderer=renderer
    // The far field only depends on camera yaw. Reuse it during automatic rotation.
    if(dustContext&&frame.yaw===previousYaw){
      if(cachedYaw!==frame.yaw||dustLayer.width!==w||dustLayer.height!==h){
        dustLayer.width=w
        dustLayer.height=h
        paintDust(dustContext,w,h,unit,frame.yaw)
        cachedYaw=frame.yaw
      }
      ctx.globalAlpha=1
      ctx.drawImage(dustLayer,0,0)
    }else{
      paintDust(ctx,w,h,unit,frame.yaw)
    }
    previousYaw=frame.yaw
    for(const glow of glows){
      frame.project(glow.x,glow.z,0,glow.belt,point)
      const size=glow.size*shortestSide*point.perspective*frame.zoom
      ctx.globalAlpha=glow.alpha
      ctx.drawImage(glow.sprite,point.x*w/100-size/2,point.y*h/100-size/2,size,size)
    }
    // WebView without WebGL2 must not project the entire decorative disc on
    // the UI thread. Keep a stable sample from every color/brightness group.
    const particleStride=particleCanvas?Math.ceil(5/resolution):1
    if(!gpu)for(let color=0;color<colors.length;color++){
      ctx.fillStyle=colors[color]
      for(const [level,group] of particles[color].entries()){
        const alpha=(level+.5)/8
        ctx.globalAlpha=alpha
        for(let index=0;index<group.length;index+=particleStride){
          const p=group[index]
          frame.project(p.x,p.z,p.height,p.belt,point)
          if(point.x<0||point.x>100||point.y<0||point.y>100)continue
          const size=p.size*unit*point.perspective*zoomScale
          const x=point.x*w/100,y=point.y*h/100
          ctx.fillRect(x,y,size,size)
        }
      }
    }
    ctx.fillStyle='#fff1dc'
    for(const p of foreground){
      const size=p.size*unit
      const x=offset(p.x,frame.yaw*.12+frame.seconds*.004)*w,y=p.y*h
      if(gpu)gpu.add(x,y,size,rgb[3],p.alpha)
      else{
        ctx.globalAlpha=p.alpha
        ctx.fillRect(x,y,size,size)
      }
    }
    ctx.globalAlpha=1
    if(gpu)for(const marker of markers){
      const diameter=marker.diameter*ratio
      const blur=marker.blur*ratio
      const size=diameter+blur*4
      gpu.add(marker.x*w/width-size/2,marker.y*h/height-size/2,size,marker.rgb,marker.alpha,diameter,blur)
    }
    if(gpu){
      for(const [i,orbit] of frame.belts.entries()){
        const offset=i*4
        orbitData[offset]=orbit.sin
        orbitData[offset+1]=orbit.cos
        orbitData[offset+2]=orbit.incline
        orbitData[offset+3]=orbit.offset
      }
      gpu.draw(w,h,orbitData,frame.pitchSin,frame.pitchCos,frame.zoom,unit)
    }
  }
  return {paint,canBatchStars:()=>batch?.available()??false,dispose:()=>batch?.dispose()}
}
