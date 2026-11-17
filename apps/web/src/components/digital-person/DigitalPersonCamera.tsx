import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { fsApi } from '../../api/client'
import { useI18n } from '../../i18n'
import { formatMarkdownAttachment } from '../../utils/markdownAttachment'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import VideoPreviewWindow from '../VideoPreviewWindow'
import { DigitalPersonCameraControlContext, useDigitalPersonCameraControl } from './digitalPersonCameraControl'
import './DigitalPersonCamera.css'
import {useCameraPanelDrag} from './useCameraPanelDrag'
import {useFaceRecognition,type RecognizedFrame} from '../face-recognition/useFaceRecognition'
import {copyFrame} from '../face-recognition/runtime'
import FaceOverlay from '../face-recognition/FaceOverlay'
import {faceApi} from '../../api/faces'
import {waitForRecognition} from '../face-recognition/operation'
import {annotateFaceFrame} from '../face-recognition/annotateFrame'

export type PrepareCameraMessage = (content: string, onFaces?: (ids:string[])=>void) => Promise<string>

/** Keyboard resizing does not change the physical camera orientation. */
function cameraPortraitScreen() {
 const type=window.screen.orientation?.type
 if(type?.startsWith('portrait'))return true
 if(type?.startsWith('landscape'))return false
 const angle=(window as Window & {orientation?:number}).orientation
 if(typeof angle==='number')return Math.abs(angle)%180===0
 const {width,height}=window.screen
 return width&&height?height>=width:window.innerHeight>=window.innerWidth
}

/** Camera remains local; a frame is encoded and uploaded only when a message is sent. */
export default function DigitalPersonCamera({ projectId, autoStart = false, active = true, compact = false, floating = false, enabled = true, children, onPrepare, presentation='window', panelContent, enrollment = false, onCaptureReady }: {
  presentation?:'window'|'panel';panelContent?:ReactNode;projectId?: string; autoStart?: boolean; active?: boolean; compact?: boolean; floating?: boolean; enabled?: boolean; children?: ReactNode
  onPrepare?: (prepare: PrepareCameraMessage | null) => void
  enrollment?: boolean
  onCaptureReady?: (capture: (()=>Promise<RecognizedFrame>)|null)=>void
}) {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null)
  const generation = useRef(0), uploading = useRef(false)
  const captureSession=useRef<AbortController|null>(null)
  const [phase, setPhase] = useState<'off' | 'opening' | 'on'>('off')
  const [error, setError] = useState(''), [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const panelDrag=useCameraPanelDrag(root,presentation==='panel'&&(phase!=='off'||Boolean(error)))
  const recognition=useFaceRecognition(phase==='on',video,enrollment)
  const analyzeFrame=recognition.analyze
  const captureFace=useCallback(async()=>{
    const source=video.current,request=generation.current
    if(!source||!stream.current||source.readyState<2)throw new Error(t('faceRecognition.notReady'))
    const frame=copyFrame(source)
    const result=await waitForRecognition(analyzeFrame(frame,true),captureSession.current?.signal)
    if(request!==generation.current)throw new Error(t('faceRecognition.notReady'))
    return result
  },[analyzeFrame,t])
  useEffect(()=>{onCaptureReady?.(phase==='on'?captureFace:null);return()=>onCaptureReady?.(null)},[onCaptureReady,phase,captureFace])
  const stop = useCallback(() => {
    captureSession.current?.abort();captureSession.current=null
    generation.current++
    const current = stream.current
    stream.current = null
    current?.getTracks().forEach(track => track.stop())
    if (video.current) video.current.srcObject = null
    setPhase('off')
  }, [])
  const start = useCallback(async (direction: 'environment' | 'user') => {
    stop(); setError(''); setPhase('opening')
    const request = generation.current
    let preview = false
    try {
      if (window.isSecureContext === false) throw new Error(t('digitalPerson.cameraSecureRequired'))
      const policyDocument = document as Document & {
        permissionsPolicy?: { allowsFeature: (feature: string) => boolean }
        featurePolicy?: { allowsFeature: (feature: string) => boolean }
      }
      const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy
      if (policy && !policy.allowsFeature('camera')) throw new Error(t('digitalPerson.cameraPolicyBlocked'))
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('digitalPerson.cameraUnavailable'))
      const portrait = cameraPortraitScreen()
      // Prefer native frames: width/height hints may crop a portrait sensor into
      // a landscape stream in Android WebView before the video element sees it.
      const supported = navigator.mediaDevices.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & { resizeMode?: boolean }) | undefined
      const nativeFrames = supported?.resizeMode
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: direction },
        ...(nativeFrames ? { resizeMode: { exact: 'none' }, aspectRatio: { ideal: portrait ? 9 / 16 : 16 / 9 } } : {}),
      } })
      if (request !== generation.current || document.hidden) { media.getTracks().forEach(track => track.stop()); return }
      stream.current = media
      captureSession.current=new AbortController()
      media.getVideoTracks().forEach(track => track.addEventListener('ended', stop, { once: true }))
      preview = true
      if (video.current) { video.current.srcObject = media; await video.current.play() }
      if (request === generation.current) setPhase('on')
    } catch (reason) {
      if (request !== generation.current) return
      stop()
      const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : ''
      const key = preview ? 'cameraPlaybackFailed'
        : name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'cameraDenied'
        : name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'cameraNotFound'
        : name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError' ? 'cameraBusy'
        : name === 'OverconstrainedError' ? 'cameraConstraints' : null
      setError(key ? t(`digitalPerson.${key}`) : reason instanceof Error ? reason.message : t('digitalPerson.cameraUnavailable'))
    }
  }, [stop, t])
  useEffect(() => {
    if (enabled && autoStart && active) void start('environment')
    const hide = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide); stop() }
  }, [enabled, autoStart, active, start, stop, projectId])

  const prepare = useCallback(async (content: string, onFaces?: (ids:string[])=>void) => {
    if (!stream.current) {
      if (phase === 'opening') throw new Error(t('digitalPerson.cameraNotReady'))
      return content
    }
    const source = video.current, current = stream.current, request = generation.current
    if (!projectId || !source || source.readyState < 2 || !source.videoWidth || !source.videoHeight || current.getVideoTracks().some(track => track.readyState === 'ended')) throw new Error(t('digitalPerson.cameraNotReady'))
    if (uploading.current) throw new Error(t('digitalPerson.cameraSending'))
    uploading.current = true
    try {
      // Preserve the complete source frame, matching the uncropped preview.
      const width = source.videoWidth, height = source.videoHeight
      const canvas = document.createElement('canvas'), ratio = Math.min(1, 1280 / Math.max(width, height))
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
      const context = canvas.getContext('2d')
      if (!context) throw new Error(t('digitalPerson.cameraNotReady'))
      context.drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height)
      let facePersonIds:string[]=[]
      try {
        const frame=await analyzeFrame(canvas)
        if(frame.catalog?.settings.enabled&&frame.catalog.settings.include_people){
          const ids=[...new Set(frame.faces.flatMap(face=>face.person?[face.person.id]:[]))]
          const people=await faceApi.context(ids,frame.faces.filter(face=>!face.person).length)
          annotateFaceFrame(canvas,frame.faces,people.people,t('faceRecognition.unknown'))
          facePersonIds=people.people.map(person=>person.person_id)
        }
      } catch { /* Optional recognition must not prevent sending the camera photo. */ }
      if(request!==generation.current||current!==stream.current)throw new Error(t('digitalPerson.cameraNotReady'))
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(t('digitalPerson.cameraNotReady'))), 'image/jpeg', .85))
      if (request !== generation.current || current !== stream.current) throw new Error(t('digitalPerson.cameraNotReady'))
      const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' })
      const uploaded = await fsApi.uploadImage(file, projectId, 'digital-person-camera')
      if (request !== generation.current || current !== stream.current) throw new Error(t('digitalPerson.cameraNotReady'))
      onFaces?.(facePersonIds)
      return `${content}\n\n${formatMarkdownAttachment(file, uploaded.url)}`
    } finally { uploading.current = false }
  }, [phase, projectId, t, analyzeFrame])
  useEffect(() => { onPrepare?.(prepare); return () => onPrepare?.(null) }, [onPrepare, prepare])
  const switchButton = phase === 'on' && <Button className="digital-person-camera-switch" variant="ghost" aria-label={t('digitalPerson.switchCamera')} title={t('digitalPerson.switchCamera')} onClick={() => { const next = facing === 'environment' ? 'user' : 'environment'; setFacing(next); void start(next) }}>{compact || floating ? <Icon name="switch-camera" size={14} /> : t('digitalPerson.switchCamera')}</Button>
  const overlay=<FaceOverlay videoRef={video} faces={recognition.faces} showNames={recognition.catalog?.settings?.show_names??true}/>
  const preview = <>
    <div className="face-camera-surface">
    <video ref={video} className="digital-person-camera-preview" hidden={phase === 'off'} autoPlay playsInline muted aria-label={t('digitalPerson.cameraPreview')} />
    {phase==='on'&&overlay}
    </div>
    {phase==='on'&&<span className="face-camera-status face-camera-status--live" role="status">
      {recognition.notice||(enrollment||recognition.catalog?.settings.enabled?<><Spinner size={12}/>{t('faceRecognition.detecting',{count:recognition.faces.length})}</>:null)}
    </span>}
    {error && <p role="alert" className="digital-person-error">{error}</p>}
  </>
  const getAnchor = useCallback(() => {
    const avatar = root.current?.closest('.digital-home')?.querySelector('[data-ui="avatar"],.digital-home-avatar')
    if (!avatar || !avatar.getBoundingClientRect().width || !avatar.getBoundingClientRect().height) return null
    const eyes = avatar.querySelector('[data-avatar-eyes]')?.getBoundingClientRect()
    return eyes ? { x: eyes.x, y: eyes.y } : null
  }, [])
  useEffect(()=>{
    if(presentation!=='panel'||typeof ResizeObserver==='undefined')return
    const node=root.current,home=node?.closest<HTMLElement>('.digital-home'),footer=node?.closest<HTMLElement>('.digital-home-footer')
    const info=home?.querySelector<HTMLElement>('.digital-home-presence-info')
    const main=home?.querySelector<HTMLElement>('.digital-home-main')
    if(!footer||!home||!info||!main)return
    const update=()=>{
      const infoBox=info.getBoundingClientRect()
      const anchorBottom=infoBox.height?infoBox.bottom:main.getBoundingClientRect().top
      home.style.setProperty('--home-camera-top',`${anchorBottom-home.getBoundingClientRect().top}px`)
      home.style.setProperty('--home-footer-height',`${footer.getBoundingClientRect().height}px`)
    }
    const observer=new ResizeObserver(update)
    for(const element of [footer,info,main,home])observer.observe(element)
    update()
    return()=>{observer.disconnect();home.style.removeProperty('--home-footer-height');home.style.removeProperty('--home-camera-top')}
  },[presentation])
  const camera = <div ref={root} style={panelDrag.style} data-camera-moved={Boolean(panelDrag.style)} onPointerDown={panelDrag.onPointerDown} onKeyDown={panelDrag.onKeyDown} className={`digital-person-camera${compact || floating ? ' digital-person-camera--compact' : ''}${floating ? ' digital-person-camera--floating' : ''}${children ? ' digital-person-camera--menu' : ''}${presentation==='panel'?' digital-person-camera--panel':''}`} data-camera-phase={phase} hidden={presentation==='panel'&&phase==='off'&&!error}>
    {!children && <div className="digital-person-camera-actions">
      <Button data-camera-toggle variant="ghost" aria-label={t(phase === 'off' ? 'digitalPerson.openCamera' : 'digitalPerson.closeCamera')} aria-busy={phase === 'opening'} aria-pressed={phase !== 'off'} disabled={!active}
        onClick={() => phase === 'off' ? void start(facing) : stop()}>{phase === 'opening' ? <Spinner size={16} /> : <Icon name="camera" size={floating ? 14 : compact ? 24 : 16} />}{!compact && !floating && t(phase === 'off' ? 'digitalPerson.openCamera' : 'digitalPerson.closeCamera')}</Button>
      {!compact && !floating && switchButton}
    </div>}
    {compact || floating ? <VideoPreviewWindow presentation={presentation} videoRef={video} overlay={overlay} actions={switchButton} error={error} getAnchor={getAnchor} label={t('digitalPerson.cameraPreview')} closeLabel={t('digitalPerson.closeCamera')} open={phase !== 'off' || Boolean(error)} onClose={() => { stop(); setError('') }}/> : <div className="digital-person-camera-media">{preview}</div>}
    {presentation==='panel'&&panelContent}
  </div>
  if (!children) return camera
  return <DigitalPersonCameraControlContext.Provider value={enabled ? {
    prepare, enabled: phase !== 'off', opening: phase === 'opening', disabled: !active,
    toggle: () => phase === 'off' ? void start(facing) : stop(),
  } : null}>{children}{enabled && camera}</DigitalPersonCameraControlContext.Provider>
}

/** Media controls outside the input can share the composer's camera session. */
export function DigitalPersonCameraToggle() {
  const camera = useDigitalPersonCameraControl(), { t } = useI18n()
  if (!camera) return null
  return <div className="digital-person-camera digital-person-camera--compact"><Button data-camera-toggle variant="ghost"
    aria-label={t(camera.enabled ? 'digitalPerson.closeCamera' : 'digitalPerson.openCamera')}
    aria-busy={camera.opening} aria-pressed={camera.enabled} disabled={camera.disabled} onClick={camera.toggle}>
    {camera.opening ? <Spinner size={16} /> : <Icon name="camera" size={24} />}
  </Button></div>
}
