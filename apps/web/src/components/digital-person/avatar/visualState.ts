/** Full artwork poses deliberately avoid deforming fingers or cutting armor joints. */
export function avatarPose(phase:string,playing:boolean){
 return !playing&&['thinking','working','checking'].includes(phase)?'thinking':'neutral'
}
export function advanceVoice(previous:{level:number;activity:number},playing:boolean,level:number,deltaMs:number){
 const target=playing&&Number.isFinite(level)?Math.max(0,Math.min(1,level)):0
 const damp=(from:number,to:number,ms:number)=>to+(from-to)*Math.exp(-Math.max(0,deltaMs)/ms)
 return {level:damp(previous.level,target,target>previous.level?120:340),activity:damp(previous.activity,playing?1:0,playing?280:900)}
}

export function advanceOrbSpeechLevel(previous:number,level:number,deltaMs:number){
 const target=Number.isFinite(level)?Math.max(0,Math.min(1,level)):0
 return target+(previous-target)*Math.exp(-Math.max(0,deltaMs)/(target>previous?29:90))
}

export function advanceMicLevel(previous:number,level:number,deltaMs:number){
 const audible=Number.isFinite(level)?Math.min(1,Math.max(0,level-.012)):0
 // Lift quiet speech while leaving room for louder syllables.
 const target=1.32*audible/(.32+audible)
 const value=target+(previous-target)*Math.exp(-Math.max(0,deltaMs)/(target>previous?22:68))
 return value<.004?0:value
}
