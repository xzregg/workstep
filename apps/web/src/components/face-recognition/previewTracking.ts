import {faceBoxOverlap,type FaceObservation} from './runtime'

const confirmationWindowMs=750
const holdMs=1500

interface Track {
 face:FaceObservation
 accepted:FaceObservation|null
 hitAt:number
}

export class PreviewFaceTracking {
 private tracks:Track[]=[]
 private similarity:(a:number[],b:number[])=>number

 constructor(similarity:(a:number[],b:number[])=>number){this.similarity=similarity}

 update(faces:FaceObservation[],at:number,threshold:number){
  // Require a unique association in both directions. Faces that cross or
  // leave the picture cannot pass their label or first hit to another box.
  const links=faces.map(face=>this.tracks.filter(track=>faceBoxOverlap(track.face.box,face.box)>=.4))
  this.tracks=faces.map((face,index)=>{
   const [track]=links[index]
   const previous=track&&links[index].length===1&&links.filter(items=>items.includes(track)).length===1?track:undefined
   const accepted=previous&&at-previous.hitAt<holdMs?previous.accepted:null
   if(face.person){
    const repeated=previous?.face.person?.id===face.person.id&&at-previous.hitAt<=confirmationWindowMs
    return {face,accepted:accepted?.person?.id===face.person.id||repeated?face:null,hitAt:at}
   }
   const sameFace=accepted&&!face.ambiguous&&face.embedding.length>0&&face.embedding.length===accepted.embedding.length&&
    this.similarity(face.embedding,accepted.embedding)>=Math.max(.65,threshold)
   return {face,accepted:sameFace?accepted:null,hitAt:previous?.hitAt??at}
  })
  return this.visible(at)
 }

 visible(at:number){
  return this.tracks.map(({face,accepted,hitAt})=>({...face,person:at-hitAt<holdMs?accepted?.person??null:null}))
 }

 nextExpiry(at:number){
  return Math.min(...this.tracks.flatMap(track=>track.accepted&&track.hitAt+holdMs>at?[track.hitAt+holdMs]:[]))
 }
}
