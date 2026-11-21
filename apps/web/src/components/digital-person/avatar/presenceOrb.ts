import {createParticleCloud} from './particleCloud'
import {colors,poses,type OrbPhase} from './particlePalette'
import {vertex,fragment} from './particleShaders'
import {advanceOrbSpeechLevel} from './visualState'

const tempo:Partial<Record<OrbPhase,number>>={
 idle:1.16,wake:.48,listening:.66,ready:.7,transcribe:1.9,sending:1.65,
 thinking:1.77,check:1.54,work:2.35,write:1.25,synth:.85,playing:.92,
 wait:0,muted:0,stopped:0,error:0,
}
// Relative shell size and wave strength. The core stays anchored during pose changes.
const shellPose:Partial<Record<OrbPhase,readonly [number,number]>>={
 ready:[.88,.052],listening:[1.06,.045],transcribe:[.84,.075],sending:[.91,.095],
 thinking:[.91,.052],check:[.94,.054],work:[1.12,.115],write:[1.03,.067],
 synth:[.91,.065],playing:[1.03,.063],wait:[.90,.016],muted:[.88,0],
 stopped:[.82,0],error:[.86,.019],
}
const idleShell=[1,.008] as const
export interface PresenceReply {id:string;status?:string}
function wakeHeartbeat(seconds:number){
  const beat=(seconds%3)/3
  if(beat<.35)return .105*Math.sin(Math.PI*beat/.35)**2
  if(beat<.70)return .052*Math.sin(Math.PI*(beat-.35)/.35)**2
  return 0
}
export function createOrb(canvas:HTMLCanvasElement,lightweight=false){
  const context=canvas.getContext('webgl',{alpha:true,antialias:false,powerPreference:'low-power'})
  if(!context)throw Error('WebGL unavailable')
  const gl=context
  const program=gl.createProgram()!,buffer=gl.createBuffer(),shaders:WebGLShader[]=[]
  const dispose=()=>{
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    for(const shader of shaders)gl.deleteShader(shader)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  try{
    for(const [kind,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]] as const){
      const shader=gl.createShader(kind)!
      shaders.push(shader)
      gl.shaderSource(shader,source)
      gl.compileShader(shader)
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader)??'Particle shader')
      gl.attachShader(program,shader)
    }
    gl.linkProgram(program)
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program)??'Particle program')
    gl.useProgram(program)
    const particles=createParticleCloud(lightweight)
    const count=particles.length/6
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer)
    gl.bufferData(gl.ARRAY_BUFFER,particles,gl.STATIC_DRAW)
    canvas.dataset.particleCount=String(count)
    for(const [name,offset] of [['position',0],['meta',12]] as const){
      const loc=gl.getAttribLocation(program,name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc,3,gl.FLOAT,false,24,offset)
    }
    const loc=Object.fromEntries(['fit','size','t','energy','light','breath','afterglow','seconds','mood','thought','tint','pass','motion','flights[0]'].map(name=>[name,gl.getUniformLocation(program,name)]))
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.ONE,gl.ONE_MINUS_SRC_COLOR,gl.ONE,gl.ONE_MINUS_SRC_ALPHA)
    const tint=new Float32Array(4),mood=new Float32Array(3),flights=new Float32Array(16)
    let clock=0,orbit=0,thought=0,glow=0,speechLevel=0,slot=0,nextRelease=0
    let breath=0,phaseAge=0,lastPhase:OrbPhase='idle'
    let shellScale=1,shellWave:number=idleShell[1],workStarted=-Infinity,completedAt=-Infinity
    let lastWorkActivity:string|undefined,lastReplyId:string|undefined,lastReplyStatus:string|undefined
    function draw(delta:number,state:OrbPhase,level:number,still:boolean,mic=0,activityId='',reply?:PresenceReply){
      const rect=canvas.getBoundingClientRect()
      if(!rect.width||!rect.height)return false
      const dpr=Math.min(devicePixelRatio||1,lightweight?1.1:1.5,(lightweight?600:840)/Math.max(rect.width,rect.height))
      const width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr))
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height)}
      const dt=Math.min(.10,Math.max(0,delta/1000)),blend=(tau:number)=>still?1:1-Math.exp(-dt/tau)
      const phaseChanged=lastPhase!==state
      phaseAge=phaseChanged?0:phaseAge+dt
      if(!still){clock+=dt;orbit+=dt*(tempo[state]??1)}
      if(still){workStarted=-Infinity;completedAt=-Infinity}
      else{
        if(state==='work'&&lastWorkActivity!==activityId)workStarted=clock
        if(reply&&lastReplyId===reply.id&&lastReplyStatus==='running'&&reply.status==='succeeded')completedAt=clock
      }
      if(state==='work')lastWorkActivity=activityId
      lastPhase=state;lastReplyId=reply?.id;lastReplyStatus=reply?.status
      const toolProgress=state==='work'?(clock-workStarted)/.83:Infinity
      const completionProgress=(clock-completedAt)/1.12
      const listening=state==='listening'&&!still?Math.min(1,Math.max(0,mic)):0
      const speechActive=state==='playing'&&!still
      const sample=speechActive&&Number.isFinite(level)?Math.min(1,Math.max(0,level)):0
      const rise=sample-speechLevel
      const energy=speechLevel=speechActive?advanceOrbSpeechLevel(speechLevel,sample,dt*1000):0
      if(still)flights.fill(0)
      if(sample>.08&&rise>.045&&clock>=nextRelease){
        flights[2*slot]=clock
        flights[2*slot+1]=Math.sqrt(sample)
        slot=(slot+1)%8
        nextRelease=clock+.13
      }
      for(let i=0;i<4;i++)tint[i]+=(colors[state][i]-tint[i])*blend(.32)
      for(let i=0;i<3;i++)mood[i]+=((poses[state]?.[i]??0)-mood[i])*blend(.21)
      thought+=((state==='thinking'?1:state==='check'?.68:0)-thought)*blend(.24)
      const [scale,wave]=shellPose[state]??idleShell
      shellScale+=(scale+.085*listening+.068*energy-shellScale)*blend(.18)
      shellWave+=(wave+.036*listening+.042*energy-shellWave)*blend(.18)
      const targetBreath=state==='wake'&&!still?wakeHeartbeat(phaseAge):0
      breath+=(targetBreath-breath)*blend(state==='wake'?.055:.18)
      gl.uniform1f(loc.breath,breath)
      const targetGlow=Math.sqrt(energy)
      glow+=(targetGlow-glow)*blend(targetGlow>glow?.045:.13)
      const side=Math.min(width,height)
      const fitScale=Math.min(1,.9+Math.max(0,rect.width/rect.height-1)*.18)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform2f(loc.fit,fitScale*side/width,fitScale*side/height)
      gl.uniform1f(loc.size,side/342)
      gl.uniform1f(loc.t,orbit)
      gl.uniform1f(loc.seconds,clock)
      gl.uniform1f(loc.energy,energy)
      gl.uniform1f(loc.afterglow,glow)
      gl.uniform1f(loc.light,(lightweight?1.30:1.13)+.36*listening)
      gl.uniform1f(loc.thought,thought)
      gl.uniform2fv(loc['flights[0]'],flights)
      gl.uniform3fv(loc.mood,mood)
      gl.uniform4fv(loc.tint,tint)
      gl.uniform4f(loc.motion,shellScale,shellWave,toolProgress<1?toolProgress:-1,completionProgress<1?completionProgress:-1)
      for(const pass of [1,0]){
        gl.uniform1f(loc.pass,pass)
        gl.drawArrays(gl.POINTS,0,count)
      }
      canvas.dataset.phase=state
      canvas.dataset.level=energy.toFixed(3)
      canvas.dataset.frame=String(Math.round(clock*1000))
      canvas.dataset.cue=completionProgress<1?'completed':toolProgress<1?'tool':''
      return !still&&(tempo[state]!==0||phaseAge<2.8||completionProgress<1)
    }
    return {draw,dispose}
  }catch(error){dispose();throw error}
}
