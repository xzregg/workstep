import type {FaceFramePerson} from '../../api/faces'
import type {FaceObservation} from './runtime'

/** Burn annotations into the same captured canvas before JPEG encoding. */
export function annotateFaceFrame(canvas:HTMLCanvasElement,faces:FaceObservation[],people:FaceFramePerson[],unknownLabel:string,showBoxes=true){
 const context=canvas.getContext('2d');if(!context)return
 const names=new Map(people.map(person=>[person.person_id,person]))
 const fontSize=Math.max(14,Math.min(24,Math.round(canvas.width/40))),padding=6,lineHeight=fontSize+6
 context.save()
 try{
  context.font=`500 ${fontSize}px system-ui, sans-serif`;context.textBaseline='top';context.lineWidth=Math.max(2,canvas.width/400)
  for(const face of faces){
   if(face.box.length!==4||!face.box.every(Number.isFinite))continue
   const [nx,ny,nw,nh]=face.box
   const x=Math.max(0,Math.min(canvas.width-1,nx*canvas.width)),y=Math.max(0,Math.min(canvas.height-1,ny*canvas.height))
   const width=Math.min(canvas.width-x,nw*canvas.width),height=Math.min(canvas.height-y,nh*canvas.height)
   if(width<=0||height<=0)continue
   const person=face.person?names.get(face.person.id):undefined,color=person?'#69bd8a':'#e7bb5b'
   if(showBoxes){context.strokeStyle=color;context.strokeRect(x,y,width,height)}
   const maxWidth=Math.min(canvas.width,Math.max(width,canvas.width*.45)),lines=[person?.name||unknownLabel]
   const labels=lines.map(line=>{
    let text=line
    while(text.length>1&&context.measureText(text).width>maxWidth-padding*2){text=Array.from(text).slice(0,-1).join('')}
    return text===line?text:text+'…'
   })
   const labelWidth=Math.min(canvas.width,Math.max(...labels.map(text=>context.measureText(text).width))+padding*2)
   const labelHeight=lineHeight*labels.length+padding*2,left=Math.min(x,canvas.width-labelWidth),top=Math.max(0,Math.min(y>=labelHeight?y-labelHeight:y,canvas.height-labelHeight))
   context.fillStyle=color;context.fillRect(left,top,labelWidth,labelHeight)
   context.fillStyle='#17231b';labels.forEach((label,index)=>context.fillText(label,left+padding,top+padding+index*lineHeight))
  }
 }finally{context.restore()}
}
