import {damp} from '../../../avatars/motion'
import {createCanvasLoop} from './canvasLoop'
import {avatarPose} from './visualState'
import type {AvatarSnapshot} from '../../../avatars/runtime'
import {type RobotState,type RobotActivity} from './robotRig'

const vertex=`attribute vec2 uv;uniform vec2 fit;varying vec2 texcoord;
void main(){gl_Position=vec4((uv.x-.5)*2.2*fit.x,(.52-uv.y)*2.2*fit.y,0.,1.);texcoord=uv;}`
// Keep facial effects in UV space so they follow the head bone.
const fragment=`precision mediump float;uniform sampler2D image;uniform float mouth;uniform float mouthGlow;uniform float eyeGlow;uniform float jointGlow;uniform float blink;uniform float affinity;uniform vec2 eyeCenter;varying vec2 texcoord;
void main(){vec2 uv=texcoord;
if(uv.x>.466&&uv.x<.565&&uv.y>.474&&uv.y<.523)uv.y=.490+(uv.y-.490)/(1.+mouth*1.5);
vec4 color=texture2D(image,uv);
if(texcoord.x>.405&&texcoord.x<.633&&texcoord.y>.312&&texcoord.y<.417){
 float emissive=smoothstep(.15,.45,color.g-color.r);
 float lid=smoothstep(mix(.05,.002,blink),mix(.054,.006,blink),abs(texcoord.y-eyeCenter.y));
 vec3 face=texture2D(image,vec2(uv.x,.405)).rgb;
 color.rgb=mix(color.rgb,face,emissive*lid);
 color.rgb+=vec3(.08,.3,.3)*eyeGlow*emissive*(1.-blink);
}
vec2 mouthDistance=vec2(max(abs(texcoord.x-.506)-.032,0.),texcoord.y-.490)/vec2(.014,.012);
float glow=exp(-dot(mouthDistance,mouthDistance));
color.rgb+=vec3(.35,.65,.65)*glow*mouthGlow;
// Light only the artwork's cyan joint rings, leaving metal and the face alone.
float jointRegion=max(1.-smoothstep(.022,.045,abs(texcoord.y-.55)),step(.665,texcoord.y));
float jointEmission=jointRegion*smoothstep(.12,.45,color.g-color.r)*smoothstep(.10,.4,color.b-color.r)*color.a;
color.rgb*=1.-jointEmission*(.38-.26*jointGlow);
color.rgb+=vec3(.08,.38,.38)*jointEmission*jointGlow;
float chest=step(.435,texcoord.x)*step(texcoord.x,.585)*step(.58,texcoord.y)*step(texcoord.y,.657)*smoothstep(.12,.4,min(color.g-color.r,color.b-color.r));
vec3 warm=mix(vec3(.04,.95,.95),vec3(1.,.09,.19),affinity);
color.rgb=mix(color.rgb,warm*max(color.r,max(color.g,color.b)),chest*step(0.,affinity));
gl_FragColor=color;}`

/** Intact artwork poses: no joint splitting or mesh deformation. Not a skeletal rig. */
export async function createRobotRenderer(canvas:HTMLCanvasElement,src:string,thinkingSrc:string,getState:()=>{state:RobotState;level:number;emotion?:string;intensity?:number;activity?:RobotActivity|null;presentation?:AvatarSnapshot},onError:()=>void){
 const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:true,powerPreference:'low-power'})
 if(!gl)throw new Error('WebGL unavailable')
 const shaders:WebGLShader[]=[],textures:WebGLTexture[]=[]
 const program=gl.createProgram()!,buffer=gl.createBuffer()!
 let loop:ReturnType<typeof createCanvasLoop>|undefined,disposed=false
 const cleanup=()=>{if(disposed)return;disposed=true;loop?.dispose();canvas.removeEventListener('webglcontextlost',lost);gl.deleteBuffer(buffer);textures.forEach(t=>gl.deleteTexture(t));gl.deleteProgram(program);shaders.forEach(s=>gl.deleteShader(s));gl.getExtension('WEBGL_lose_context')?.loseContext()}
 const lost=(event:Event)=>{event.preventDefault();cleanup();onError()}
 try{
  for(const [type,source]of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]] as const){
   const shader=gl.createShader(type)!;shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader)
   if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('Avatar shader failed')
   gl.attachShader(program,shader)
  }
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Avatar program failed')
  const images=await Promise.all([src,thinkingSrc].map(async url=>{const image=new Image();image.src=url;await image.decode();return image}))
  gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),gl.STATIC_DRAW)
  const id=gl.getAttribLocation(program,'uv');gl.enableVertexAttribArray(id);gl.vertexAttribPointer(id,2,gl.FLOAT,false,0,0)
  for(const image of images){const texture=gl.createTexture()!;textures.push(texture);gl.bindTexture(gl.TEXTURE_2D,texture)
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR)
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
   gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image)
  }
  const loc=Object.fromEntries(['fit','mouth','mouthGlow','eyeGlow','blink','jointGlow','affinity','eyeCenter'].map(name=>[name,gl.getUniformLocation(program,name)]))
  let smoothLevel=0
  loop=createCanvasLoop(canvas,(now,delta,reduced)=>{
   const current=getState(),playing=current.presentation?.speech.playing??current.state==='speaking'
   const pose=avatarPose(current.presentation?.phase??current.state,playing)
   const {width,height}=canvas.getBoundingClientRect();if(width<=0||height<=0)return false
   const ratio=Math.min(devicePixelRatio||1,2),w=Math.round(width*ratio),h=Math.round(height*ratio)
   if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h)}
   const side=Math.min(width,height)
   canvas.parentElement?.style.setProperty('--avatar-eyes-x',`${width/2+((pose==='thinking'?.515:.519)-.5)*1.1*side}px`)
   canvas.parentElement?.style.setProperty('--avatar-eyes-y',`${height/2-(.52-(pose==='thinking'?.336:.358))*1.1*side}px`)
   smoothLevel=reduced?0:damp(smoothLevel,playing?current.level:0,delta,120)
   const t=now/1000,blink=reduced?0:Math.max(0,1-Math.abs(t%5.7-3)/.10),breath=reduced?.6:.5+.5*Math.sin(t*1.4)
   gl.useProgram(program);gl.bindTexture(gl.TEXTURE_2D,textures[pose==='thinking'?1:0]);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT)
   gl.uniform2f(loc.fit,Math.min(w,h)/w,Math.min(w,h)/h)
   // Light the mouth without stretching its geometry or the surrounding chin.
   gl.uniform2f(loc.eyeCenter,pose==='thinking'?.515:.519,pose==='thinking'?.336:.358);gl.uniform1f(loc.mouth,0);gl.uniform1f(loc.mouthGlow,playing?.15+smoothLevel*.85:0)
   gl.uniform1f(loc.eyeGlow,reduced?.2:.3+.15*Math.sin(t*1.7));gl.uniform1f(loc.blink,blink);gl.uniform1f(loc.jointGlow,breath)
   gl.uniform1f(loc.affinity,current.presentation?.affinity==null?-1:current.presentation.affinity/100)
   gl.drawArrays(gl.TRIANGLES,0,6)
   canvas.dataset.avatarPose=pose;canvas.dataset.jointGlow=breath.toFixed(3);canvas.dataset.blink=blink.toFixed(3);canvas.dataset.frame=String(Math.round(now));canvas.dataset.motion=reduced?'still':pose
   return !reduced
  })
  canvas.addEventListener('webglcontextlost',lost)
  return {dispose:cleanup,invalidate:loop.invalidate}
 }catch(error){cleanup();throw error}
}
