import type {PrototypeDocument} from '../../api/prototype'

export type FrameTarget={path:string;document:PrototypeDocument;route:number[];frames:{file:string;selector:string}[]}
const key=(route:number[])=>route.join('.')
/** Only consume envelopes from the trusted top preview WindowProxy, in the caller. */
export class PrototypeFrameRouting {
  activeRoute:number[]=[]
  passivePath=''
  readonly targets=new Map<string,FrameTarget>()
  readonly snapshots=new Map<string,{route:number[];path:string}>()
  private token=''
  private validRoute(route:unknown):route is number[]{return Array.isArray(route)&&route.length>0&&route.length<=8&&route.every(index=>Number.isInteger(index)&&index>=0&&index<1000)}
  accept(data:Record<string,any>,root:PrototypeDocument,files:Set<string>,editing:boolean):'loaded'|'restore'|null{
    if(data.token!==root.html_preview.token||!this.validRoute(data.route)||!files.has(data.path))return null
    if(this.token!==data.token){this.targets.clear();this.token=data.token}
    const document=data.document as PrototypeDocument|undefined
    if(!document||document.html_preview?.token!==data.token||document.html_preview.entry!==data.path||typeof document.version!=='string'||!document.nodes)return null
    const route=data.route as number[],id=key(route),saved=this.snapshots.get(id)
    if(editing&&saved&&saved.path!==data.path)return 'restore'
    this.targets.set(id,{path:data.path,document,route,frames:Array.isArray(data.frames)?data.frames:[]})
    this.snapshots.set(id,{route,path:data.path})
    return 'loaded'
  }
  resolve(data:Record<string,any>,root:PrototypeDocument):FrameTarget|null{
    if(data.token!==root.html_preview.token||!this.validRoute(data.route))return null
    const target=this.targets.get(key(data.route))
    return target&&target.path===data.path&&target.document.version===data.version?target:null
  }
  get active(){return this.targets.get(key(this.activeRoute))}
  get saved(){return [...this.snapshots.values()]}
  select(target:FrameTarget){this.activeRoute=target.route}
  isActive(route:number[]){return key(route)===key(this.activeRoute)}
  reset(){this.activeRoute=[];this.passivePath='';this.targets.clear();this.snapshots.clear();this.token=''}
}
