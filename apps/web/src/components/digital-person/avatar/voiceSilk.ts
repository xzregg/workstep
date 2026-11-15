const silkVertex=`precision highp float;attribute vec2 param;uniform float time;uniform float energy;uniform float activity;uniform float sheet;uniform float aspect;uniform float expanded;varying vec3 position;varying vec3 normal;varying vec2 texcoord;
vec3 shape(float u,float v){vec3 p;float t=time;
float x=(u-.5)*4.6;float a=(u-.5)*3.14159265;float twist=a*1.1+.42*sin(t*.3)+sheet*1.4;float w=(.53+.15*energy)*pow(max(0.,sin(u*3.14159265)),.55)+.035;
  p=vec3(x+v*w*.10*sin(twist),.60*sin(a*1.3+t*.34+sheet*1.6)+(.5-sheet)*.36+v*w*cos(twist),.48*sin(a+sheet*.85+t*.22)+v*w*sin(twist));

 float yaw=.3+.13*sin(t*.18),pitch=.12+.05*sin(t*.23);p=vec3(cos(yaw)*p.x+sin(yaw)*p.z,p.y,-sin(yaw)*p.x+cos(yaw)*p.z);p=vec3(p.x,cos(pitch)*p.y-sin(pitch)*p.z,sin(pitch)*p.y+cos(pitch)*p.z);float roll=.12*sin(t*.22);p.xy=mat2(cos(roll),sin(roll),-sin(roll),cos(roll))*p.xy;p*=.94+.06*activity+.045*energy;return p;
}
void main(){float u=param.x,v=param.y;vec3 p=shape(u,v);vec3 du=shape(u+.001,v)-shape(u-.001,v),dv=shape(u,v+.001)-shape(u,v-.001);normal=normalize(cross(du,dv));position=p;texcoord=vec2(u,v);p*=expanded;float w=5.4-p.z;gl_Position=vec4(p.x*2.5/aspect,p.y*2.5+.80,w*.3,w);}`;
const silkFragment=`precision highp float;uniform float time;uniform float energy;uniform float activity;uniform float sheet;uniform float glow;varying vec3 position;varying vec3 normal;varying vec2 texcoord;
void main(){vec3 n=normalize(normal),v=normalize(vec3(0.,0.,5.4)-position);float facing=abs(dot(n,v)),fresnel=pow(1.-facing,2.8);vec3 key=normalize(vec3(-.65,.7,1.)),rim=normalize(vec3(.85,-.4,.6));float spec=pow(abs(dot(n,normalize(key+v))),38.);float reflection=pow(abs(dot(n,rim)),5.);float edge=pow(abs(texcoord.y),20.);float fold=.5+.5*sin(texcoord.x*9.+time*.25);vec3 base=mix(vec3(.008,.045,.24),vec3(.015,.15,.60),reflection);
 if(sheet>.5)base=mix(base,vec3(.20,.12,.55),.25+.18*fold);
 vec3 blue=vec3(.05,.25,1.),ice=vec3(.80,.95,1.);vec3 color=base+blue*(fresnel*1.2+edge*.9)+ice*(spec*.75+edge*.25);color+=vec3(.20,.10,.055)*reflection*.10;
 float opacity=(.4+.4*fresnel+.28*spec+.20*edge)*(.18+.82*activity)*(.75+.25*energy);
 if(glow>.5){opacity=(fresnel*.08+edge*.06)*(.2+.8*activity);color=blue;}
 color=1.-exp(-color*2.2);gl_FragColor=vec4(color*opacity,opacity);
}`;
export function createSilk(canvas:HTMLCanvasElement){
 const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:true,powerPreference:'low-power'});if(!gl)throw new Error('当前浏览器不支持动态背景');
 let buffer:WebGLBuffer|null=null,ib:WebGLBuffer|null=null;const program=gl.createProgram()!;const shaders:WebGLShader[]=[];const compile=(type:number,source:string)=>{const s=gl.createShader(type)!;shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)??'Voice shader failed');return s};const dispose=()=>{gl.deleteBuffer(buffer);gl.deleteBuffer(ib);gl.deleteProgram(program);shaders.forEach(s=>gl.deleteShader(s));gl.getExtension('WEBGL_lose_context')?.loseContext()};try{gl.attachShader(program,compile(gl.VERTEX_SHADER,silkVertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,silkFragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??'Voice program failed');gl.useProgram(program);
 const U=128,V=20,vertices=[],indices=[];for(let u=0;u<=U;u++)for(let v=0;v<=V;v++)vertices.push(u/U,v/V*2-1);for(let u=0;u<U;u++)for(let v=0;v<V;v++){const a=u*(V+1)+v,b=a+V+1;indices.push(a,b,a+1,a+1,b,b+1)}
 buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);const a=gl.getAttribLocation(program,'param');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.DEPTH_TEST);
 const loc=Object.fromEntries(['time','energy','activity','sheet','aspect','expanded','glow'].map(n=>[n,gl.getUniformLocation(program,n)]));
 return {canvas,draw(time:number,energy:number,activity:number){const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;const dpr=Math.min(devicePixelRatio||1,1.5),w=Math.round(r.width*dpr),h=Math.round(r.height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h)}gl.useProgram(program);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform1f(loc.time,time);gl.uniform1f(loc.energy,energy);gl.uniform1f(loc.activity,activity);gl.uniform1f(loc.aspect,r.width/r.height);
 const count=2;for(let s=count-1;s>=0;s--){gl.uniform1f(loc.sheet,s);gl.uniform1f(loc.glow,1);gl.uniform1f(loc.expanded,1.025);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);gl.uniform1f(loc.glow,0);gl.uniform1f(loc.expanded,1);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0)}canvas.dataset.level=energy.toFixed(3);canvas.dataset.activity=activity.toFixed(3);canvas.dataset.frame=String(Math.round(time*1000));}
 ,dispose };
 }catch(error){dispose();throw error}
}
