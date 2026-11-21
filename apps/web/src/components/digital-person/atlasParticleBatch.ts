// The disc stays in GPU memory. Only the camera and interactive markers change per frame.
const vertexSource=`#version 300 es
layout(location=0) in vec3 bounds;
layout(location=1) in vec4 color;
layout(location=2) in vec2 star;
uniform vec2 viewport;
uniform bool disc;
uniform vec4 camera;
uniform vec4 orbits[10];
flat out vec3 particle;
flat out vec4 tint;
flat out vec2 starStyle;
void main(){
  tint=color;
  if(disc){
    vec4 orbit=orbits[int(star.x)];
    float rotatedX=bounds.x*orbit.y-bounds.y*orbit.x;
    float rotatedZ=bounds.x*orbit.x+bounds.y*orbit.y;
    float y=bounds.z+bounds.y*orbit.z+orbit.w;
    float depth=y*camera.x+rotatedZ*camera.y;
    float tilt=y*camera.y-rotatedZ*camera.x;
    float perspective=3.8/(3.8-depth);
    float scale=.31*camera.z*perspective;
    vec2 top=vec2(.5)+scale*vec2(rotatedX*cos(.29)-tilt*sin(.29),
      -1.35*(rotatedX*sin(.29)+tilt*cos(.29)));
    float size=star.y*camera.w*perspective;
    particle=vec3(top*viewport,size);
    starStyle=vec2(0.);
    gl_PointSize=ceil(size)+2.;
    vec2 center=(particle.xy+size*.5)/viewport;
    gl_Position=any(lessThan(top,vec2(0.)))||any(greaterThan(top,vec2(1.)))
      ?vec4(2.,2.,0.,1.):vec4(center*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
    return;
  }
  vec2 corner=vec2(float(gl_VertexID & 1),float(gl_VertexID >> 1));
  vec2 position=bounds.xy-.5+corner*(bounds.z+1.);
  gl_Position=vec4(position/viewport*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
  particle=bounds;
  starStyle=star;
}
`
const fragmentSource=`#version 300 es
precision highp float;
uniform vec2 viewport;
flat in vec3 particle;
flat in vec4 tint;
flat in vec2 starStyle;
out vec4 pixel;
void main(){
  vec2 cell=vec2(gl_FragCoord.x,viewport.y-gl_FragCoord.y)-.5;
  if(starStyle.x>0.){
    float distanceToCenter=length(cell+.5-particle.xy-particle.z*.5);
    float radius=starStyle.x*.5;
    float edge=max(.55,radius*.18);
    float core=1.-smoothstep(max(0.,radius-edge),radius+edge,distanceToCenter);
    float glow=.16*exp(-pow(max(0.,distanceToCenter-radius)/starStyle.y,2.)*2.4);
    vec3 nucleus=mix(vec3(.933,.918,.965),tint.rgb,clamp(distanceToCenter/max(radius,.01),0.,1.));
    float alpha=tint.a*(core+glow*(1.-core));
    pixel=vec4(tint.a*(nucleus*core+tint.rgb*glow*(1.-core)),alpha);
    return;
  }
  vec2 coverage=max(vec2(0.),min(cell+1.,particle.xy+particle.z)-max(cell,particle.xy));
  float alpha=tint.a*coverage.x*coverage.y;
  pixel=vec4(tint.rgb*alpha,alpha);
}
`

export function atlasParticleBatch(canvas:HTMLCanvasElement,discData:Float32Array,capacity:number) {
  const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,depth:false,powerPreference:'low-power'})
  if(!gl)return null
  const program=gl.createProgram()
  const buffer=gl.createBuffer()
  const discBuffer=gl.createBuffer()
  const discArray=gl.createVertexArray()
  const markerArray=gl.createVertexArray()
  function compile(type:number,source:string) {
    const shader=gl!.createShader(type)
    if(!shader)return null
    gl!.shaderSource(shader,source)
    gl!.compileShader(shader)
    return shader
  }
  const vertex=compile(gl.VERTEX_SHADER,vertexSource)
  const fragment=compile(gl.FRAGMENT_SHADER,fragmentSource)
  if(program&&vertex&&fragment){
    gl.attachShader(program,vertex)
    gl.attachShader(program,fragment)
    gl.linkProgram(program)
  }
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if(!program||!buffer||!discBuffer||!discArray||!markerArray||!gl.getProgramParameter(program,gl.LINK_STATUS)){
    gl.deleteProgram(program)
    gl.deleteBuffer(buffer)
    gl.deleteBuffer(discBuffer)
    gl.deleteVertexArray(discArray)
    gl.deleteVertexArray(markerArray)
    return null
  }
  const viewport=gl.getUniformLocation(program,'viewport')
  const disc=gl.getUniformLocation(program,'disc')
  const camera=gl.getUniformLocation(program,'camera')
  const orbits=gl.getUniformLocation(program,'orbits[0]')
  const floatsPerParticle=9
  const stride=floatsPerParticle*Float32Array.BYTES_PER_ELEMENT
  const data=new Float32Array(capacity*floatsPerParticle)
  let count=0
  gl.useProgram(program)
  function bindAttributes(array:WebGLVertexArrayObject,source:WebGLBuffer,divisor:number){
    gl!.bindVertexArray(array)
    gl!.bindBuffer(gl!.ARRAY_BUFFER,source)
    for(const [index,size,offset] of [[0,3,0],[1,4,3],[2,2,7]]){
      gl!.enableVertexAttribArray(index)
      gl!.vertexAttribPointer(index,size,gl!.FLOAT,false,stride,offset*Float32Array.BYTES_PER_ELEMENT)
      gl!.vertexAttribDivisor(index,divisor)
    }
  }
  bindAttributes(discArray,discBuffer,0)
  gl.bufferData(gl.ARRAY_BUFFER,discData,gl.STATIC_DRAW)
  bindAttributes(markerArray,buffer,1)
  gl.bufferData(gl.ARRAY_BUFFER,data.byteLength,gl.DYNAMIC_DRAW)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA)

  return {
    available:()=>!gl.isContextLost(),
    add(x:number,y:number,size:number,rgb:number[],alpha:number,diameter=0,blur=0){
      let index=count++*floatsPerParticle
      data[index++]=x
      data[index++]=y
      data[index++]=size
      data[index++]=rgb[0]
      data[index++]=rgb[1]
      data[index++]=rgb[2]
      data[index++]=alpha
      data[index++]=diameter
      data[index]=blur
    },
    draw(width:number,height:number,orbitData:Float32Array,pitchSin:number,pitchCos:number,zoom:number,unit:number){
      if(canvas.width!==width||canvas.height!==height){
        canvas.width=width
        canvas.height=height
      }
      gl.viewport(0,0,width,height)
      gl.clearColor(0,0,0,0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform2f(viewport,width,height)
      gl.uniform1i(disc,1)
      gl.uniform4f(camera,pitchSin,pitchCos,zoom,unit*Math.sqrt(zoom))
      gl.uniform4fv(orbits,orbitData)
      gl.bindVertexArray(discArray)
      gl.drawArrays(gl.POINTS,0,discData.length/floatsPerParticle)
      gl.uniform1i(disc,0)
      gl.bindVertexArray(markerArray)
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer)
      gl.bufferSubData(gl.ARRAY_BUFFER,0,data,0,count*floatsPerParticle)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,count)
      count=0
    },
    dispose(){
      gl.deleteBuffer(buffer)
      gl.deleteBuffer(discBuffer)
      gl.deleteVertexArray(discArray)
      gl.deleteVertexArray(markerArray)
      gl.deleteProgram(program)
    },
  }
}
