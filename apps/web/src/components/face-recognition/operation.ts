import {zhCNT} from '../../i18n'

export class FaceOperationError extends Error {
 readonly reason:'timeout'|'interrupted'
 constructor(reason:'timeout'|'interrupted'){
  super(zhCNT(reason==='timeout'?'faceRecognition.timeout':'faceRecognition.interrupted'))
  this.reason=reason
 }
}

/** Stop waiting without pretending that an in-flight GPU operation was cancelled. */
export function waitForRecognition<T>(operation:Promise<T>,signal?:AbortSignal,timeout=45000):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>finish(()=>reject(new FaceOperationError('interrupted')))
  const timer=setTimeout(()=>finish(()=>reject(new FaceOperationError('timeout'))),timeout)
  const finish=(settle:()=>void)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);settle()}
  signal?.addEventListener('abort',abort,{once:true})
  operation.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)))
  if(signal?.aborted)abort()
 })
}
