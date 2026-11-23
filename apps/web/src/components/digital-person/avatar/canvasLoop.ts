/** The owner invalidates on input changes; hidden/offscreen elements never keep a RAF alive. */
export function createCanvasLoop(element:Element,draw:(now:number,delta:number,reduced:boolean)=>boolean){
 let frame=0,last=0,disposed=false,intersects=true
 const media=window.matchMedia('(prefers-reduced-motion: reduce)')
 const visible=()=>!disposed&&!document.hidden&&intersects
 const render=(now:number)=>{
  frame=0;if(!visible())return
  const delta=last?Math.max(0,now-last):1000/30
  if(now-last<1000/30){frame=requestAnimationFrame(render);return}
  last=now
  if(draw(now,delta,media.matches)&&!media.matches)frame=requestAnimationFrame(render)
 }
 const invalidate=()=>{if(visible()&&!frame)frame=requestAnimationFrame(render)}
 const visibility=()=>{cancelAnimationFrame(frame);frame=0;last=0;invalidate()}
 const resize=new ResizeObserver(invalidate);resize.observe(element)
 const intersection=new IntersectionObserver(entries=>{intersects=entries[0]?.isIntersecting??true;visibility()});intersection.observe(element)
 document.addEventListener('visibilitychange',visibility);media.addEventListener('change',visibility)
 invalidate()
 return {invalidate,dispose(){disposed=true;cancelAnimationFrame(frame);resize.disconnect();intersection.disconnect();document.removeEventListener('visibilitychange',visibility);media.removeEventListener('change',visibility)}}
}
