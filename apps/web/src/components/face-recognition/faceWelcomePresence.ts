const maxFrameGap=2500
const stableFor=1500

interface Track {
 present:boolean
 left:boolean
 absentMs:number
 matchSince:number
 matches:number
}

/** Samples only accepted, fresh frames from one continuous camera stream. */
export class FaceWelcomePresence {
 private tracks=new Map<string,Track>()
 private lastFrame?:number

 reset(){
  this.tracks.clear()
  this.lastFrame=undefined
 }

 observe(ids:readonly (string|null)[],at:number,awayMinutes:number){
  if(this.lastFrame!==undefined&&at<=this.lastFrame)return null
  if(this.lastFrame!==undefined&&at-this.lastFrame>maxFrameGap)this.reset()
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
    if(track.left&&ids.length===1)candidate=id
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
