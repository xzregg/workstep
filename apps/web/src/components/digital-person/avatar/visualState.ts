/** Full artwork poses deliberately avoid deforming fingers or cutting armor joints. */
export function avatarPose(phase:string,playing:boolean){
 return !playing&&['thinking','working','checking'].includes(phase)?'thinking':'neutral'
}
export function advanceVoice(previous:{level:number;activity:number},playing:boolean,level:number,deltaMs:number){
 const target=playing&&Number.isFinite(level)?Math.max(0,Math.min(1,level)):0
 const damp=(from:number,to:number,ms:number)=>to+(from-to)*Math.exp(-Math.max(0,deltaMs)/ms)
 return {level:damp(previous.level,target,target>previous.level?120:340),activity:damp(previous.activity,playing?1:0,playing?280:900)}
}
