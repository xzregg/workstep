import type { AtlasLink } from '../../api/digitalPerson'

type Point = {x:number;y:number}
type Segment = {start:Point;end:Point}
type Candidate<Link> = Segment & {link:Link;score:number}
const epsilon = 1e-6
export const focusedChainDepth = 5

function orientation(a:Point,b:Point,c:Point) {
  const cross=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)
  return Math.abs(cross)<epsilon?0:Math.sign(cross)
}

function intersects(a:Segment,b:Segment) {
  const shared=[a.start,a.end].find(point=>point===b.start||point===b.end)
  if(shared){
    const p=a.start===shared?a.end:a.start
    const q=b.start===shared?b.end:b.start
    return orientation(shared,p,q)===0&&(p.x-shared.x)*(q.x-shared.x)+(p.y-shared.y)*(q.y-shared.y)>0
  }
  return Math.max(a.start.x,a.end.x)>=Math.min(b.start.x,b.end.x)
    &&Math.max(b.start.x,b.end.x)>=Math.min(a.start.x,a.end.x)
    &&Math.max(a.start.y,a.end.y)>=Math.min(b.start.y,b.end.y)
    &&Math.max(b.start.y,b.end.y)>=Math.min(a.start.y,a.end.y)
    &&orientation(a.start,a.end,b.start)*orientation(a.start,a.end,b.end)<=0
    &&orientation(b.start,b.end,a.start)*orientation(b.start,b.end,a.end)<=0
}

export const atlasLinkKey=({from,to}:AtlasLink)=>from+'/'+to

function focusedChain<Link extends AtlasLink>(candidates:Candidate<Link>[],focus:string){
  const byEnd=new Map<string,Candidate<Link>[]>()
  for(const candidate of candidates){
    for(const id of [candidate.link.from,candidate.link.to]){
      const list=byEnd.get(id)
      if(list)list.push(candidate)
      else byEnd.set(id,[candidate])
    }
  }
  const seen=new Set([focus])
  const accepted:Candidate<Link>[]=[]
  let tail=focus
  while(accepted.length<focusedChainDepth){
    const segment=byEnd.get(tail)?.find(segment=>{
      const {from,to}=segment.link
      return !seen.has(from===tail?to:from)&&!accepted.some(other=>intersects(segment,other))
    })
    if(!segment)break
    const {from,to}=segment.link
    tail=from===tail?to:from
    seen.add(tail)
    accepted.push(segment)
  }
  return accepted.map(({link})=>link)
}

export function constellationLinks<Link extends AtlasLink>(
  links:readonly Link[],positions:ReadonlyMap<string,Point>,maxLength:number,previous:ReadonlySet<string>=new Set(),
  focus?:string,
):Link[] {
  const nearby:Candidate<Link>[]=[]
  for(const link of links){
    const start=positions.get(link.from),end=positions.get(link.to)
    if(!start||!end)continue
    const length=Math.hypot(end.x-start.x,end.y-start.y)
    if(length<1||(focus===undefined&&length>maxLength))continue
    // Keep a segment when two projected lengths are nearly tied.
    nearby.push({link,start,end,score:length*(previous.has(atlasLinkKey(link))?.88:1)})
  }
  nearby.sort((a,b)=>a.score-b.score)
  if(focus!==undefined)return focusedChain(nearby,focus)

  const degree=new Map<string,number>()
  const parent=new Map<string,string>()
  function root(id:string):string {
    while(parent.has(id))id=parent.get(id)!
    return id
  }
  const accepted:typeof nearby=[]
  for(const segment of nearby){
    const {from,to}=segment.link
    const left=degree.get(from)??0,right=degree.get(to)??0
    if(left===2||right===2)continue
    const first=root(from),second=root(to)
    if(first===second||accepted.some(other=>intersects(segment,other)))continue
    degree.set(from,left+1)
    degree.set(to,right+1)
    parent.set(first,second)
    accepted.push(segment)
  }
  return accepted.map(segment=>segment.link)
}
