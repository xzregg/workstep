import {coreDrop,shellOrigin} from './presenceShell'

export const vertex=`precision highp float;
attribute vec3 position,meta;uniform float t,energy,size,light,breath,afterglow,seconds;uniform vec2 fit;uniform vec3 mood;uniform float thought;uniform vec4 tint,motion;uniform vec2 flights[8];uniform mediump float pass;varying mediump vec3 color;varying mediump float alpha;varying mediump float shellGlow;
mat2 rot(float a){return mat2(cos(a),sin(a),-sin(a),cos(a));}
float signalBand(float depth,float progress){
 if(progress<0.)return 0.;
 float offset=(depth-mix(-.94,.94,progress))*7.;
 return exp(-offset*offset)*sin(3.14159*progress);
}
float heartbeat(float age){
 float phase=mod(age,2.42);
 float first=(phase-.20)/.105,second=(phase-.49)/.13;
 return exp(-first*first)+.55*exp(-second*second);
}
void main(){
 float id=meta.x,seed=meta.z;
 shellGlow=step(10.,id)+.48*step(11.,id)+.36*step(12.,id);
 vec3 p=position;
 if(id==8.){
   float a=position.x*6.28318+t*1.25;
   float r=.32+.025*position.y;
   vec2 orbit=rot(seed>.5?.62:-.62)*vec2(cos(a)*r,sin(a)*r*.39);
   gl_Position=vec4(orbit*fit,0.,1.);
   color=vec3(.60,.72,.99);alpha=thought*meta.y*(.84+.32*sin(a-position.x*2.));
   gl_PointSize=size*(pass>.5?3.8:1.75);return;
 }
 if(id==6.){
   vec2 dust=fract((position.xy+1.)*.5+t*vec2(.0008+seed*.0012,.0004+position.z*.0007))*2.-1.;
   gl_Position=vec4(dust,.92,1.);
   color=mix(vec3(.16,.42,.58),vec3(.52,.76,.86),position.z);
   alpha=meta.y*(.22+.47*smoothstep(.32,.85,length(dust)))*light;
   gl_PointSize=size*(.83+1.1*pow(seed,3.))*(pass>.5?2.6:1.);
   return;
 }
 float voice=smoothstep(.012,.64,energy);
 vec3 center=vec3(${shellOrigin[0]},${shellOrigin[1]},0.);
 vec3 q=p-center;float particleFade=1.;
 float toolSignal=0.,completionSignal=0.;
 float release=motion.w>=0.?sin(3.14159*motion.w):0.;
 float coreBeat=heartbeat(seconds);
 float beat=coreBeat;
 if(id==3.||id==4.){
   float coreRadius=length(q);
   float pulse=sin(seconds*1.7+coreRadius*19.+q.y*13.);
   q.xz=rot(seconds*(.50+1.1*exp(-9.*coreRadius))+.21*pulse)*q.xz;
   q.y+=.018*pulse*sin(q.x*10.+q.z*13.-seconds);
   q*=1.+.07*pulse+.21*coreBeat-.13*heartbeat(seconds+.13);
   if(id==3. && seed<.76){
     float group=floor(seed*8./.76);
     vec2 flight=vec2(0.);
     for(int i=0;i<8;i++){if(float(i)==group)flight=flights[i];}
     float variation=fract(seed*237.51);
     float age=(seconds-flight.x-variation*.24)/(1.20+.7333*variation);
     if(flight.y>0. && age>0. && age<1.20){
       if(age<1.){
         vec3 drift=normalize(q+vec3(.04*sin(seed*723.),.05*cos(seed*283.),.035));
         float distance=(1.-exp(-2.1*age))*(.19+.25*variation)*(.55+.65*flight.y);
         q+=drift*distance;
         q.xy+=vec2(-drift.y,drift.x)*.065*age*variation;
         particleFade=1.-smoothstep(.45,1.,age);
       }else{particleFade=smoothstep(1.,1.20,age);}
     }
   }
   q.y-=${coreDrop.toFixed(2)};
 }
 float flow=0.;
 if(id>=10.||id==5.){
   float distanceFromCore=length(q+vec3(0.,${coreDrop.toFixed(2)},0.));
   beat=heartbeat(seconds-distanceFromCore*.69);
   float phase=dot(q,vec3(6.7,8.2,-5.2))+seconds*1.85;
   float eddy=dot(q,vec3(-9.1,4.2,7.3))-seconds*1.48;
   flow=.5+.5*sin(phase+.56*cos(eddy));
   // Move along the surface so currents can surge without widening the silhouette.
   vec3 tangent=cross(q,vec3(sin(eddy),cos(phase),sin(phase-eddy)));
   float drift=id==5.?.16:id==10.?.15:.095;
   q+=tangent*drift;
 }
 // Keep a fixed view of the sphere while the particles flow within it.
 q.xz=rot(.41)*q.xz;
 q.yz=rot(.24)*q.yz;
 q.xy=rot(-.12)*q.xy;
 if(id>=10.||id==5.){
   float wave=sin(dot(normalize(q),vec3(3.4,4.1,2.2))+t*.9);
   toolSignal=signalBand(dot(q,vec3(.42,.82,.47)),motion.z);
   completionSignal=signalBand(q.y,motion.w);
   q*=motion.x+wave*motion.y+.025*beat+.082*release+.045*toolSignal;
 }
 p=q;
 float f=clamp(.53+p.z*.86,0.,1.),proj=3.8/(3.8-p.z);
 gl_Position=vec4(1.10*(1.+breath)*proj*p.xy*fit,-p.z*.35,1.);
 color=mix(vec3(.027,.37,.83),vec3(.60,.99,1.),f*.58+meta.y*.38);
 if(id==3.){
   float core=1.-smoothstep(.074,.194,length(position-center));
   color=mix(vec3(.15,.73,1.),vec3(1.,1.,.91),.91*core+.09*meta.y);
 }
 alpha=meta.y*(.40+f*.86)*light;
 if(id==3.)alpha*=(1.41+.62*coreBeat+.32*voice+.53*release)*particleFade;
 if(id==4.){color=vec3(.57,.91,1.);alpha*=.028+.052*coreBeat+afterglow*.078;}
 if(id==5.){
   color=mix(vec3(.15,.65,.99),vec3(.83,.99,1.),f);
   alpha*=(1.59+1.10*f+.56*flow+.95*beat+.40*toolSignal+.44*completionSignal);
 }
 if(id>=10.)alpha*=mix(.12,1.,smoothstep(-.04,.05,q.z)+
 (1.-smoothstep(-.04,.05,q.z))*smoothstep(.045,.15,length(q.xy)));
 if(id>=10.){
   float front=smoothstep(-.46,.52,q.z);
   float rim=pow(1.-abs(normalize(q).z),2.);
   float along=.5+.5*cos(dot(q,vec3(7.,5.,3.))-t*1.7+id*.83);
   float strand=step(11.,id),fiber=step(12.,id);
   vec3 cyan=mix(vec3(.035,.52,1.),vec3(.92,1.,.96),clamp(.19*rim+.54*meta.y+.21*front+.40*strand-.18*fiber,0.,1.));
   color=mix(cyan,tint.rgb,tint.a*.47);
   color=mix(color,vec3(.91,1.,1.),clamp(toolSignal+.78*completionSignal,0.,1.));
   alpha*=(.55+1.15*front+.63*rim)*(.80+.45*along)*(1.+mood.x*(front-.49)+mood.y*(along-.42)*.55);
   alpha*=.84+.34*flow+.42*beat+.30*strand-.20*fiber+1.55*toolSignal+1.38*completionSignal+.30*voice;
 }
 alpha*=1.-.59*mood.z;
 gl_PointSize=size*(1.+breath)*proj*(id==4.?6.5:.83+f*.65+pow(seed,8.)*.82)*(pass>.5?4.8+1.15*shellGlow:1.+.24*shellGlow);

}`;
export const fragment=`precision mediump float;varying mediump vec3 color;varying mediump float alpha;varying mediump float shellGlow;uniform float pass;
void main(){
vec2 q=gl_PointCoord*2.-1.;float d=dot(q,q);if(d>1.)discard;
float k=pass>.5?(.056+.078*shellGlow)*exp(-(3.8-.55*shellGlow)*d):.87*exp(-2.1*d);
gl_FragColor=vec4(color*alpha*k,clamp(alpha*k,0.,1.));}`;
