import type { ImgHTMLAttributes } from 'react'
import { useDirectResource } from '../webrtc/useDirectResource'

export default function DirectImage({src,...props}:ImgHTMLAttributes<HTMLImageElement>){
  const resource=useDirectResource(src||'')
  return <img {...props} src={resource}/>
}
