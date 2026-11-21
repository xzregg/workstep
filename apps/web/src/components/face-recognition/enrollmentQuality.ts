import type {FaceDetection} from './runtime'
import type {RecognizedFrame} from './useFaceRecognition'

export const enrollmentPoses=['front','left','right','up','down'] as const
type EnrollmentPose=(typeof enrollmentPoses)[number]
export const enrollmentHoldMs=650
export const enrollmentSampleInterval=120
export const enrollmentMaxFrameGap=2000

export function enrollmentIssue({canvas,faces}:RecognizedFrame,target:EnrollmentPose){
 const face=faces[0]
 if(faces.length!==1||face.score<.65||!face.pose||!face.faceBox)return 'needOne' as const
 const [left,top,width,height]=face.faceBox
 if(left<.01||top<.01||left+width>.99||top+height>.99)return 'centerFace' as const
 if(width*canvas.width<70||height*canvas.height<76)return 'moveCloser' as const
 const {yaw,pitch,roll}=face.pose
 if(![yaw,pitch,roll].every(Number.isFinite))return 'needOne' as const
 const within=(value:number,min:number,max:number)=>value>=min&&value<=max
 const horizontal=target==='left'||target==='right',vertical=target==='up'||target==='down'
 const turn=target==='left'?-yaw:yaw,tilt=target==='up'?-pitch:pitch
 if(Math.abs(roll)>12||(!horizontal&&Math.abs(yaw)>11)||(!vertical&&Math.abs(pitch)>15))return 'adjustPose' as const
 if(horizontal&&!within(turn,12,40)||vertical&&!within(tilt,13,38))return 'adjustPose' as const
 return imageIssue(canvas,face.faceBox)
}

function imageIssue(canvas:HTMLCanvasElement,[left,top,width,height]:number[]){
 const crop=document.createElement('canvas'),size=48
 crop.width=crop.height=size
 const context=crop.getContext('2d',{willReadFrequently:true})
 if(!context)return 'needOne' as const
 context.drawImage(canvas,(left+width*.18)*canvas.width,(top+height*.2)*canvas.height,width*.64*canvas.width,height*.62*canvas.height,0,0,size,size)
 const {data}=context.getImageData(0,0,size,size),gray=new Float32Array(size*size)
 let brightness=0,texture=0
 for(let index=0;index<gray.length;index++){
  const channel=index*4
  gray[index]=.2126*data[channel]+.7152*data[channel+1]+.0722*data[channel+2]
  brightness+=gray[index]
 }
 if(brightness/gray.length<45||brightness/gray.length>225)return 'lighting' as const
 for(let row=1;row<size-1;row++)for(let col=1;col<size-1;col++){
  const index=row*size+col
  const edge=4*gray[index]-gray[index-1]-gray[index+1]-gray[index-size]-gray[index+size]
  texture+=edge*edge
 }
 if(texture/((size-2)**2)<14)return 'blur' as const
 return null
}

export function sameEnrollmentPose(first:FaceDetection,next:FaceDetection){
 const nextBox=next.faceBox
 return Boolean(first.pose&&next.pose&&first.faceBox&&nextBox&&Math.abs(first.pose.yaw-next.pose.yaw)<=7&&Math.abs(first.pose.pitch-next.pose.pitch)<=7&&Math.abs(first.pose.roll-next.pose.roll)<=7
  &&first.faceBox.every((value,index)=>Math.abs(value-nextBox[index])<=.055))
}
