const vertex=`precision highp float;
attribute vec4 seed;uniform float time;uniform float radius;uniform float spin;uniform float rotation;uniform float scatter;uniform float pulse;uniform float heat;uniform vec3 cold;uniform float audio;uniform float mode;uniform float dpr;uniform mediump float glow;uniform vec2 fit;varying vec4 tint;
void main(){vec3 p=seed.xyz;float a=rotation;float breath=sin(time*1.55)*pulse;
float wave=sin(p.y*9.+time*2.2)*sin(p.x*7.-time*.8);
float scan=exp(-pow((p.y-sin(time*1.25))/.11,2.));
float thought=sin(time*2.+p.y*7.)*.025*heat;
p*=radius+breath*.09+wave*(.008+audio*.085)+thought;
p+=normalize(seed.xyz)*scatter*.07*sin(time+seed.z*13.);
float ca=cos(a),sa=sin(a);p=vec3(ca*p.x+sa*p.z,p.y,-sa*p.x+ca*p.z);
float pitch=.18+.06*sin(time*.32);p=vec3(p.x,cos(pitch)*p.y-sin(pitch)*p.z,sin(pitch)*p.y+cos(pitch)*p.z);
float depth=(p.z+1.)*.5;float rim=pow(1.-abs(seed.z),2.);float gain=.75+.6*depth+.5*rim;
vec3 cyan=cold;vec3 amber=vec3(1.,.65,.2);vec3 color=mix(cyan,amber,heat*(.32+.5*max(0.,sin(seed.y*8.+time*1.8))));
color+=vec3(.24,.26,.30)*audio;
float work=step(2.5,mode)*step(mode,3.5);color+=vec3(.12,.38,.7)*scan*work;
tint=vec4(color,(gain*(.18+.95*depth*depth)+scan*work*.2)*(seed.w>.5?.38:1.));
gl_Position=vec4(p.x*.79*fit.x,p.y*.79*fit.y,0.,1.);
gl_PointSize=((seed.w>.5?.9:1.8)+depth*(seed.w>.5?.3:1.8)+audio*.8+scan*work*.8)*dpr*(glow>.5?3.2:1.);}`;
const fragment=`precision mediump float;varying vec4 tint;uniform mediump float glow;void main(){vec2 d=gl_PointCoord-.5;float r=length(d);float alpha=exp(-r*r*15.)*smoothstep(.5,.2,r);gl_FragColor=vec4(tint.rgb,alpha*tint.a*(glow>.5?.13:1.));}`;
export interface OrbValues {radius:number;spin:number;scatter:number;pulse:number;heat:number;rotation:number}
export function createOrb(canvas:HTMLCanvasElement){
 const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:true,preserveDrawingBuffer:true,powerPreference:'low-power'});if(!gl)throw Error('WebGL unavailable')
 const shaders:WebGLShader[]=[],program=gl.createProgram()!,buffer=gl.createBuffer();
 const dispose=()=>{gl.deleteBuffer(buffer);gl.deleteProgram(program);shaders.forEach(s=>gl.deleteShader(s));gl.getExtension('WEBGL_lose_context')?.loseContext()};
 try{
 for(const[type,source]of[[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){const shader=gl.createShader(type as number)!;shaders.push(shader);gl.shaderSource(shader,source as string);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader)??'Orb shader');gl.attachShader(program,shader)}
 gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program)??'Orb program');gl.useProgram(program)
 const count=12500,points=new Float32Array(count*4),gold=Math.PI*(3-Math.sqrt(5));
 for(let i=0;i<count;i++){const y=1-2*(i%11000+.5)/11000,r=Math.sqrt(1-y*y),a=gold*i;points.set(i<11000?[Math.cos(a)*r,y,Math.sin(a)*r,0]:[Math.cos(a)*1.26,Math.sin(a)*.25,Math.sin(a)*1.26,1],i*4)}
 gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,points,gl.STATIC_DRAW);const seed=gl.getAttribLocation(program,'seed');gl.enableVertexAttribArray(seed);gl.vertexAttribPointer(seed,4,gl.FLOAT,false,0,0)
 gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.disable(gl.DEPTH_TEST)
 const names=['time','radius','spin','scatter','pulse','heat','audio','mode','dpr','fit','rotation','glow','cold'],loc=Object.fromEntries(names.map(n=>[n,gl.getUniformLocation(program,n)]))
 return {draw(t:number,values:OrbValues,audio:number,mode:number,palette:'light'|'dark'='dark'){const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.6);if(!r.width||!r.height)return;const w=Math.round(r.width*dpr),h=Math.round(r.height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h)}gl.useProgram(program);gl.blendFuncSeparate(gl.SRC_ALPHA,palette==='dark'?gl.ONE:gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.uniform3fv(loc.cold,palette==='light'?[.08,.42,.78]:[.06,.89,1.]);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform2f(loc.fit,Math.min(w,h)/w,Math.min(w,h)/h);gl.uniform1f(loc.time,t);gl.uniform1f(loc.audio,audio);gl.uniform1f(loc.mode,mode);gl.uniform1f(loc.dpr,dpr);gl.uniform1f(loc.rotation,values.rotation||0);for(const name of ['radius','spin','scatter','pulse','heat'] as const)gl.uniform1f(loc[name],values[name]);gl.uniform1f(loc.glow,1);gl.drawArrays(gl.POINTS,0,count);gl.uniform1f(loc.glow,0);gl.drawArrays(gl.POINTS,0,count);canvas.dataset.phase=String(mode);canvas.dataset.level=audio.toFixed(3);canvas.dataset.frame=String(Math.round(t*1000))},dispose};
 }catch(error){dispose();throw error}
}
