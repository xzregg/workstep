type Rect={x:number;y:number;width:number;height:number}
type Label=Rect & {value:string;fill:string;color:string;font:string;leftPadding:number;rightPadding:number}
type Mark=Rect & {outline:number;color:string;label?:Label}
type FaceAnnotations={width:number;height:number;marks:Mark[]}

/** Read the committed preview synchronously while capturing the video frame. */
export function captureFaceAnnotations(overlay:HTMLDivElement|null):FaceAnnotations|null{
 const frame=overlay?.getBoundingClientRect(),view=overlay?.ownerDocument.defaultView
 if(!overlay||!frame?.width||!frame.height||!view)return null
 const scale=parseFloat(view.getComputedStyle(overlay).getPropertyValue('--video-preview-scale'))||1
 const rect=(element:Element):Rect=>{
  const box=element.getBoundingClientRect()
  return {x:(box.left-frame.left)/scale,y:(box.top-frame.top)/scale,width:box.width/scale,height:box.height/scale}
 }
 const marks=Array.from(overlay.querySelectorAll('.face-box'),element=>{
  const style=view.getComputedStyle(element),span=element.querySelector('span')
  const outline=element.classList.contains('face-box--no-outline')?0:parseFloat(style.borderTopWidth)||0
  if(!span)return {...rect(element),outline,color:style.borderTopColor}
  const labelStyle=view.getComputedStyle(span)
  return {...rect(element),outline,color:style.borderTopColor,label:{
   ...rect(span),value:span.textContent??'',fill:labelStyle.backgroundColor,color:labelStyle.color,
   font:`${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`,
   leftPadding:parseFloat(labelStyle.paddingLeft)||0,rightPadding:parseFloat(labelStyle.paddingRight)||0,
  }}
 })
 return {width:frame.width/scale,height:frame.height/scale,marks}
}

/** Composite only the frozen preview marks. Recognition for message context uses the raw frame. */
export function annotateFaceFrame(canvas:HTMLCanvasElement,annotations:FaceAnnotations|null){
 if(!annotations?.marks.length)return
 const context=canvas.getContext('2d');if(!context)return
 context.save()
 try{
  context.scale(canvas.width/annotations.width,canvas.height/annotations.height)
  context.textBaseline='middle'
  for(const {x,y,width,height,outline,color,label} of annotations.marks){
   if(outline){
    context.strokeStyle=color;context.lineWidth=outline
    context.strokeRect(x+outline/2,y+outline/2,Math.max(0,width-outline),Math.max(0,height-outline))
   }
   if(!label?.value||!label.width||!label.height)continue
   context.fillStyle=label.fill;context.fillRect(label.x,label.y,label.width,label.height)
   const maxWidth=label.width-label.leftPadding-label.rightPadding
   if(maxWidth<=0)continue
   context.font=label.font
   const letters=Array.from(label.value)
   let value=label.value
   while(letters.length&&context.measureText(value).width>maxWidth){
    letters.pop()
    value=letters.join('')+'…'
   }
   context.fillStyle=label.color
   context.fillText(value,label.x+label.leftPadding,label.y+label.height/2,maxWidth)
  }
 }finally{context.restore()}
}
