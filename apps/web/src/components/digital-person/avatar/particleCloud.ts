import {filamentCount,filamentPoint,shellOrigin as center,shellRadius} from './presenceShell'
const tau=Math.PI*2

export function createParticleCloud(lightweight=false){
 let seed=2719
 const rand=()=>((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/4294967296)
 const out:number[]=[]
 const samples=(count:number)=>lightweight?Math.round(count*.46):count
 const dot=(x:number,y:number,z:number,id:number,brightness:number)=>{
  out.push(x,y,z,id,brightness,rand())
 }
 const centered=(x:number,y:number,z:number,id:number,brightness:number)=>{
  dot(center[0]+x,center[1]+y,z,id,brightness)
 }

 // Sample the full volume and the thin outer layer of the same sphere.
 const volumeCount=samples(6800),bodyCount=volumeCount+samples(2200)
 for(let i=0;i<bodyCount;i++){
  const angle=rand()*tau,z=2*rand()-1
  const plane=Math.sqrt(1-z*z),x=plane*Math.cos(angle),y=plane*Math.sin(angle)
  const radial=shellRadius(x,y,z)
  const nearSurface=i>=volumeCount
  const r=radial*(nearSurface?.94+.06*rand():.18+.82*Math.cbrt(rand()))
  const current=.5+.5*Math.sin(9*x+7*y-11*z+2.2*Math.sin(6*z+5*y))
  const brightness=((nearSurface?.092:.049)+.20*current**4)*(.45+.55*rand())
  centered(r*x,r*y,r*z,10,brightness)
 }

 // Closely spaced strands form the brighter crest and lower arc of the same sphere.
 for(let arc=0;arc<2;arc++){
  for(let strand=0;strand<3;strand++){
   for(let i=0,count=samples(285);i<count;i++){
    const u=(i+rand())/count,fade=Math.sin(Math.PI*u)**.49
    const branch=Math.sin(Math.PI*u)*Math.sin(5.6*u+arc)
    const angle=(arc===0?.12:3.16)+(arc===0?2.98:2.97)*u+strand*.12*branch
    const depth=.26+.23*Math.sin(4.3*u+arc*.88)+strand*.074
     +.072*Math.sin(u*16+arc+strand*.14)
    const plane=Math.sqrt(1-depth*depth),x=plane*Math.cos(angle),y=plane*Math.sin(angle)
    const radius=shellRadius(x,y,depth)*(.97-.021*strand)-(rand()*.011)
    const ripple=.37+.63*Math.sin(9.7*u+arc*.6+strand*.62)**2
    centered(radius*x,radius*y,radius*depth,11,(.43+.23*rand())*ripple*fade*(1-.31*strand))
   }
  }
 }

 // The shorter, less luminous crossings follow the volume below its outer edge.
 const streamCount=8
 for(let stream=0;stream<streamCount;stream++){
  const tilt=(stream+.5)*Math.PI/streamCount,phase=stream*2.39
  const sinTilt=Math.sin(tilt),cosTilt=Math.cos(tilt)
  for(let i=0,count=samples(180);i<count;i++){
   const u=(i+rand())/count
   const angle=phase+(2.45+(stream%4)*.47)*u
   const side=.18*Math.sin(angle*2.4+phase)+.071*Math.sin(angle*5.3)
   const x=Math.cos(angle)*Math.cos(side),y=Math.sin(angle)*Math.cos(side),z=Math.sin(side)
   const dy=y*cosTilt-z*sinTilt,dz=y*sinTilt+z*cosTilt
   const jitter=(rand()-.5)*.037
   const radius=shellRadius(x,dy,dz)*(.71+.19*Math.sin(angle+phase)**2)+jitter
   const surge=.60+.55*Math.sin(4*u+phase)**2
   const shine=(.16+.53*rand())*Math.sin(Math.PI*u)**.5*surge
   centered(radius*x+jitter,radius*dy,radius*dz,11,shine*.79)
  }
 }

 // Fine fibers fill curled patches below the rim, leaving dark gaps between their folds.
 const foldCount=9
 for(let fold=0;fold<foldCount;fold++){
  const phase=fold*2.399,tilt=.43+1.94*fold/(foldCount-1)
  const sinTilt=Math.sin(tilt),cosTilt=Math.cos(tilt)
  const fiberCount=17,sampleCount=samples(46)
  for(let fiber=0;fiber<fiberCount;fiber++){
   const width=(fiber+.45)/fiberCount
   for(let i=0;i<sampleCount;i++){
    const u=(i+.28+.44*rand())/sampleCount
    const fade=Math.sin(Math.PI*u)
    const angle=phase+(1.46+.10*(fold%3))*u+.24*width*Math.sin(2.7*u+phase)
    const depth=.30*Math.sin(angle*1.82-phase)+.44*(width-.5)*fade
      +.077*Math.sin(10*u+width*4+phase)
    const plane=Math.sqrt(1-depth*depth),x=plane*Math.cos(angle),y=plane*Math.sin(angle)
    const dy=y*cosTilt-depth*sinTilt,dz=y*sinTilt+depth*cosTilt
    const depthScale=.79+.13*Math.sin(u*4.7+phase+width*1.7)
    const radius=shellRadius(x,dy,dz)*depthScale
    const flare=.47+.53*Math.sin(u*9.7-width*2+phase)**2
    centered(radius*x,radius*dy,radius*dz,12,fade**.65*flare*(.11+.27*rand())*(1-.43*width))
   }
  }
 }

 for(let i=0,count=samples(2700);i<count;i++){
  const angle=rand()*tau,z=2*rand()-1
  const radius=.20*rand()**.84
  const plane=radius*Math.sqrt(1-z*z)
  const x=plane*Math.cos(angle),y=plane*Math.sin(angle)
  centered(.94*x-.20*y,.34*x+1.15*y,radius*z,3,.28+.58*rand())
 }
 for(let i=0,count=samples(360);i<count;i++){
  const angle=rand()*tau,z=2*rand()-1,r=.045+.115*rand(),plane=r*Math.sqrt(1-z*z)
  centered(plane*Math.cos(angle),plane*Math.sin(angle),r*z,4,.25+.65*rand())
 }
 const filamentSamples=samples(1600)
 for(let i=0;i<filamentSamples;i++){
  const filament=i%filamentCount
  const u=(Math.floor(i/filamentCount)+rand())/Math.ceil(filamentSamples/filamentCount)
  const [x,y,z]=filamentPoint(filament,u)
  const spread=(rand()-.5)*(.009+.012*u)
  const pulse=.58+.42*Math.sin(5*u+filament)**2
  dot(x+spread,y-spread,z,5,
   (.18+.36*rand())*pulse*(1-.53*u))
 }
 for(let i=0,count=samples(430);i<count;i++)dot(rand()*2-1,rand()*2-1,rand(),6,.22+.6*rand())
 for(let i=0,count=samples(920);i<count;i++)dot(rand(),rand(),rand(),8,.4+.6*rand())
 return new Float32Array(out)
}
