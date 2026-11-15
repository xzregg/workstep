import {useEffect,useRef,useState} from 'react'
import type {AvatarSnapshot} from '../../avatars/runtime'
import type {RobotState,RobotActivity} from './avatar/robotRig'
import {avatarPose} from './avatar/visualState'
import type {createRobotRenderer} from './avatar/robotRenderer'
const artwork=new URL('../../assets/digital-person-body-relaxed.webp',import.meta.url).href
const thinkingArtwork=new URL('../../assets/digital-person-thinking.png',import.meta.url).href
export default function DigitalPersonRig({state,level=0,name,emotion='calm',intensity=0,activity,presentation,active=true}:{state:RobotState;level?:number;name:string;emotion?:string;intensity?:number;activity?:RobotActivity|null;presentation?:AvatarSnapshot;active?:boolean}){
 const canvas=useRef<HTMLCanvasElement>(null),current=useRef({state,level,emotion,intensity,activity,presentation})
 const handle=useRef<Awaited<ReturnType<typeof createRobotRenderer>>|null>(null)
 const [failed,setFailed]=useState(false)
 current.current={state,level,emotion,intensity,activity,presentation}
 useEffect(()=>{
  if(!active||failed)return
  let alive=true
  void import('./avatar/robotRenderer').then(m=>alive&&canvas.current?m.createRobotRenderer(canvas.current,artwork,thinkingArtwork,()=>current.current,()=>{if(alive)setFailed(true)}):null)
   .then(renderer=>{if(!renderer)return;if(alive)handle.current=renderer;else renderer.dispose()}).catch(()=>{if(alive)setFailed(true)})
  return()=>{alive=false;handle.current?.dispose();handle.current=null}
 },[active,failed])
 useEffect(()=>handle.current?.invalidate(),[state,level,emotion,intensity,activity,presentation])
 const pose=avatarPose(presentation?.phase??state,presentation?.speech.playing??state==='speaking')
 return <div className="digital-home-avatar" data-animation={failed||!active?'static':'artwork-pose'}>
  <span className="digital-home-avatar-eyes" data-avatar-eyes aria-hidden="true"/>
  {failed||!active?<img src={pose==='thinking'?thinkingArtwork:artwork} alt={name}/>:<canvas ref={canvas} role="img" aria-label={name}/>}
 </div>
}
