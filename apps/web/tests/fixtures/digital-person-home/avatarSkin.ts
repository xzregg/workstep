/** Independent test character: only the public skin SDK, no robot internals. */
import type {ExtensionApi,AvatarRenderProps} from '../../../src/skins/extensions'
export function activate(api:ExtensionApi){
 const h=api.React.createElement
 function Character({state,name}:AvatarRenderProps){
  const raised=state.hands==='raised',duration=state.reducedMotion?0:state.transition.durationMs
  return h('svg',{viewBox:'0 0 300 300',role:'img','aria-label':name,'data-custom-avatar':true,'data-hands':state.hands,'data-level':state.speech.level,style:{width:'100%',height:'100%',maxHeight:320}},
   h('ellipse',{cx:150,cy:266,rx:65,ry:9,fill:'#062337'}),
   h('path',{d:'M90 190 Q85 95 150 95 Q215 95 210 190 L220 250 Q200 264 182 250 Q165 264 148 250 Q130 264 112 250 Q92 264 80 250 Z',fill:'#c9eeff',stroke:'#5ec9dd',strokeWidth:3}),
   h('circle',{cx:128,cy:157,r:9,fill:'#153c5c'}),h('circle',{cx:172,cy:157,r:9,fill:'#153c5c'}),
   h('rect',{x:135,y:180,width:30,height:8,rx:4,fill:'#00d2dd',opacity:state.speech.playing?.25+.75*state.speech.level:0}),
   h('g',{style:{transform:`rotate(${raised?55:0}deg)`,transformOrigin:'101px 203px',transition:`transform ${duration}ms ease-in-out`}},
    h('ellipse',{cx:87,cy:215,rx:16,ry:25,fill:'#c9eeff',stroke:'#5ec9dd',strokeWidth:3})),
   h('ellipse',{cx:213,cy:215,rx:16,ry:25,fill:'#c9eeff',stroke:'#5ec9dd',strokeWidth:3}),
   h('circle',{cx:150,cy:155,r:1,fill:'transparent','data-avatar-eyes':true}))
 }
 return api.avatar.register({id:'test-cloud',render:Character})
}
