/** UV-space skeleton and linear blend skinning for the supplied robot artwork. */
export interface RobotActivity {kind:'think'|'work'|'reply';key:string}
export type RobotState='idle'|'listening'|'thinking'|'speaking'|'checking'
export const ROBOT_BONES=[
 {name:'root',parent:-1,x:.5,y:.81},{name:'body',parent:0,x:.5,y:.66},
 {name:'head',parent:1,x:.5,y:.55},{name:'left-arm',parent:1,x:.385,y:.59},
 {name:'left-hand',parent:3,x:.32,y:.69},{name:'right-arm',parent:1,x:.615,y:.59},
 {name:'right-hand',parent:5,x:.65,y:.72},{name:'left-thigh',parent:0,x:.44,y:.77},
 {name:'left-shin',parent:7,x:.43,y:.86},{name:'right-thigh',parent:0,x:.56,y:.77},
 {name:'right-shin',parent:9,x:.57,y:.86},
] as const
export interface RobotPose {angles:Float32Array;matrices:Float32Array;mouth:number;mouthGlow:number;eyeGlow:number;blink:number;jointGlow:number;motion:string}
const identity=()=>[1,0,0,0,1,0,0,0,1]
function multiply(a:number[],b:number[]){
 const out=new Array<number>(9).fill(0)
 for(let c=0;c<3;c++)for(let r=0;r<3;r++)for(let k=0;k<3;k++)out[c*3+r]+=a[k*3+r]*b[c*3+k]
 return out
}
const move=(x:number,y:number)=>[1,0,0,0,1,0,x,y,1]
const clamp=(v:number)=>Math.max(0,Math.min(1,v))
export function robotPose(state:RobotState,time:number,level=0,reduced=false,emotion='calm',intensity=0,activity?:RobotActivity['kind'],elapsed=time):RobotPose{
 const t=reduced?0:time,gesture=state==='speaking',thought=state==='thinking'||state==='checking'
 const angles=[0,.008*Math.sin(t*1.4),.024*Math.sin(t*.9)+(state==='listening'?-.035:thought?.04:0),
  gesture?.025*Math.sin(t*1.6):.008*Math.sin(t*1.1),gesture?.018*Math.sin(t*2.1):0,
  gesture?-.045-.035*Math.sin(t*1.8+.7):-.01*Math.sin(t*1.2+.4),gesture?-.025*Math.sin(t*2.2+.8):0,
  .005*Math.sin(t),-.004*Math.sin(t),-.005*Math.sin(t),.004*Math.sin(t)]
 const strength=clamp(intensity)
 if(emotion==='happy'||emotion==='warm'){angles[2]-=.025*strength;angles[3]-=.018*strength;angles[5]+=.018*strength}
 if(emotion==='sad'||emotion==='tired'){angles[2]+=.05*strength;angles[1]+=.02*strength}
 if(emotion==='angry'){angles[2]-=.035*strength;angles[3]+=.025*strength;angles[5]-=.025*strength}
 const kind=gesture?'reply':activity??(thought?'think':null)
 const phase=Math.max(0,elapsed),wave=Math.sin(phase*1.7)
 let motion='breathe'
 if(kind==='think'){
  const step=Math.floor(phase/4)%3
  motion=['ponder','look','focus'][step]
  angles[2]+=[-.075,.065,.035*Math.sin(phase*2)][step]
  angles[3]+=.34+.025*wave
  angles[4]-=.16
  if(step===2)angles[5]-=.08
 }else if(kind==='work'){
  const step=Math.floor(phase/4)%2
  motion=step===0?'inspect':'operate'
  angles[1]+=.018;angles[2]+=.045*Math.sin(phase*1.9)
  angles[3]-=.10+.035*wave;angles[5]+=.10-.035*wave
  angles[4]+=.10*Math.sin(phase*2.2);angles[6]-=.10*Math.sin(phase*2.2)
 }else if(kind==='reply'){
  const nod=phase>=4.5&&Math.floor((phase-1)/3.5)%2===1
  motion=phase<1?'lower-hand':nod?'nod':'talk'
  angles[2]+=(nod?.055:.018)*Math.sin(phase*2.1)
  // Speech releases the thinking pose; the mixer handles the lowering arc.
  angles[3]=.005*Math.sin(t*1.1);angles[4]=0
  angles[5]=-.006*Math.sin(t*1.2);angles[6]=0
 }
 if(reduced){angles.fill(0);motion='still'}
 const matrices=robotMatrices(angles,time,reduced)
 const cycle=t%11.6
 const eyelid=(start:number,duration:number)=>cycle>=start&&cycle<=start+duration?Math.sin((cycle-start)/duration*Math.PI):0
 const blink=reduced?0:Math.max(eyelid(2.8,.24),eyelid(7.15,.20),eyelid(7.55,.16))
 const eyeGlow=reduced?0:.08+.07*Math.sin(t*.9+.4)
 const mouthGlow=gesture?(reduced?1:.8+.2*Math.sin(t*Math.PI*2*1.2))*(.25+.75*clamp(level)):0
 const breath=.5+.5*Math.sin(t*(kind==='work'?2:kind==='think'?1.65:kind==='reply'?1.4:1.05))
 const jointGlow=reduced?.2:(kind?.18:.1)+(kind?.67:.25)*breath
 return {angles:Float32Array.from(angles),matrices,jointGlow,motion,mouth:gesture?clamp(level):0,mouthGlow,eyeGlow,blink}
}
export function robotMatrices(angles:ArrayLike<number>,time:number,reduced=false){
 const t=reduced?0:time
 const world:number[][]=[],matrices=new Float32Array(ROBOT_BONES.length*9)
 ROBOT_BONES.forEach((bone,index)=>{
  const parent=bone.parent<0?null:ROBOT_BONES.at(bone.parent)
  const x=bone.x-(parent?.x??0),y=bone.y-(parent?.y??0)+(index===0&&!reduced?.0015*Math.sin(t*2):0)
  const c=Math.cos(angles[index]),s=Math.sin(angles[index])
  const local=[c,s,0,-s,c,0,x,y,1]
  world[index]=multiply(parent?world[bone.parent]:identity(),local)
  matrices.set(multiply(world[index],move(-bone.x,-bone.y)),index*9)
 })
 return matrices
}
export function skinPoint(x:number,y:number,bone:number,pose:RobotPose){
 const m=pose.matrices.subarray(bone*9,bone*9+9)
 return [m[0]*x+m[3]*y+m[6],m[1]*x+m[4]*y+m[7]]
}
function weights(x:number,y:number):[number,number,number]{
 if(y<.55){return [2,1,clamp((.55-y)/.045)]}
 if(y<.84&&x<.37)return [4,3,clamp((y-.64)/.075)]
 if(y<.84&&x>.63)return [6,5,clamp((y-.66)/.075)]
 if(y>.755)return x<.5?[8,7,clamp((y-.80)/.10)]:[10,9,clamp((y-.80)/.10)]
 return [1,0,clamp((.80-y)/.10)]
}
export function createRobotMesh(segments=48){
 const vertices:number[]=[],indices:number[]=[]
 for(let y=0;y<=segments;y++)for(let x=0;x<=segments;x++){
  const u=x/segments,v=y/segments,[a,b,w]=weights(u,v)
  vertices.push(u,v,a,b,w,1-w)
 }
 for(let y=0;y<segments;y++)for(let x=0;x<segments;x++){
  const a=y*(segments+1)+x,b=a+segments+1
  indices.push(a,b,a+1,a+1,b,b+1)
 }
 return {vertices:new Float32Array(vertices),indices:new Uint16Array(indices)}
}
