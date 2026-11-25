const maxFrameGap=2500
const stableFor=1500

interface Track {
 present:boolean
 left:boolean
 absentMs:number
 matchSince:number
 matches:number
}

/** Samples fresh frames and accepts a timed gap only from a deliberate camera close. */
export class FaceWelcomePresence {
 private tracks=new Map<string,Track>()
 private lastFrame?:number
 private reopenPending=false

 reset(){
  this.tracks.clear()
  this.lastFrame=undefined
  this.reopenPending=false
 }

 observe(ids:readonly (string|null)[],at:number,awayMinutes:number,cameraOffMs=0){
  if(this.lastFrame!==undefined&&at<=this.lastFrame)return null
  if(this.lastFrame!==undefined&&at-this.lastFrame>maxFrameGap)this.reset()
  if(cameraOffMs>=awayMinutes*60_000)this.reopenPending=true
  const elapsed=this.lastFrame===undefined?0:at-this.lastFrame
  this.lastFrame=at
  const known=new Set(ids.filter((id):id is string=>id!==null))
  for(const id of known){
   if(!this.tracks.has(id))this.tracks.set(id,{present:false,left:false,absentMs:0,matchSince:at,matches:0})
  }
  let candidate:string|null=null
  for(const [id,track] of this.tracks){
   if(known.has(id)){
    if(track.matches++===0)track.matchSince=at
    if(track.matches<3||at-track.matchSince<stableFor)continue
    if((track.left||this.reopenPending)&&ids.length===1)candidate=id
    this.reopenPending=false
    track.present=true
    track.left=false
    track.absentMs=0
   }else{
    track.matches=0
    if(!track.present||ids.includes(null))continue
    track.absentMs+=elapsed
    if(track.absentMs>=awayMinutes*60_000)track.left=true
   }
  }
  return candidate
 }
}
