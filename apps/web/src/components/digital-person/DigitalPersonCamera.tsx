import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { fsApi } from '../../api/client'
import { useI18n, localizeErrorDisplay } from '../../i18n'
import { formatMarkdownAttachment } from '../../utils/markdownAttachment'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import VideoPreviewWindow from '../VideoPreviewWindow'
import { DigitalPersonCameraControlContext, useDigitalPersonCameraControl } from './digitalPersonCameraControl'
import './DigitalPersonCamera.css'
import {cameraPanelEdges,useCameraPanelDrag} from './useCameraPanelDrag'
import {matchedPersonIds,useFaceRecognition,type RecognizedFrame,type FaceWelcomeObserver} from '../face-recognition/useFaceRecognition'
import {copyFrame,type FaceObservation} from '../face-recognition/runtime'
import FaceOverlay from '../face-recognition/FaceOverlay'
import {faceApi,includesFaceContext} from '../../api/faces'
import {waitForRecognition} from '../face-recognition/operation'
import {annotateFaceFrame,captureFaceAnnotations} from '../face-recognition/annotateFrame'
import {useDelayedPending} from './useDelayedPending'
import {readHomePreference,writeHomePreference} from './homePreferences'
import CameraSwitch from './CameraSwitch'
import {listRearLenses,readRearLens,writeRearLens} from './cameraLenses'

export type CameraFaceCallback = (ids:string[],recent?:boolean)=>void
export type PrepareCameraMessage = (content: string, onFaces?: CameraFaceCallback) => Promise<string>

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
export default function DigitalPersonCamera({ projectId, preferenceScope, autoStart = false, active = true, compact = false, floating = false, enabled = true, children, onPrepare, presentation='window', enrollment = false, enrollmentTracking, onCaptureReady, onWelcomeFrame, onOpen, onManualOpen, onManualClose }: {
  presentation?:'window'|'panel';projectId?: string; preferenceScope?: string; autoStart?: boolean; active?: boolean; compact?: boolean; floating?: boolean; enabled?: boolean; children?: ReactNode
  onWelcomeFrame?: FaceWelcomeObserver
  onOpen?: () => void
  onManualOpen?: () => void
  onManualClose?: () => void
  onPrepare?: (prepare: PrepareCameraMessage | null) => void
  enrollment?: boolean
  enrollmentTracking?: {face:FaceObservation|null;progress:number|null}
  onCaptureReady?: (capture: (()=>Promise<RecognizedFrame>)|null)=>void
}) {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  const faceOverlay = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null)
  const generation = useRef(0), uploading = useRef(false)
  const openingRequest = useRef<number | null>(null)
  const cameraRestored = useRef(false)
  const captureSession=useRef<AbortController|null>(null)
  const [phase, setPhase] = useState<'off' | 'opening' | 'on'>('off')
  const [rearLenses,setRearLenses] = useState<string[]>([])
  const [selectedLens,setSelectedLens] = useState('')
  const [error, setError] = useState(''), [facing, setFacing] = useState<'environment' | 'user'>(() =>
    enrollment || (preferenceScope && readHomePreference(preferenceScope,'frontCamera')) ? 'user' : 'environment')
  const panelDrag=useCameraPanelDrag(root,presentation==='panel'&&(phase!=='off'||Boolean(error)))
  const recognition=useFaceRecognition(phase==='on'&&!enrollment,video,enrollment,onWelcomeFrame)
  const {analyze:analyzeFrame,recentMatch}=recognition
  const captureFace=useCallback(async()=>{
    const source=video.current,request=generation.current
    if(!source||!stream.current||source.readyState<2)throw new Error(t('faceRecognition.notReady'))
    const frame=copyFrame(source,enrollment?640:1280)
    const signal=captureSession.current?.signal
    const result=await waitForRecognition(analyzeFrame(frame,true),signal)
    if(request!==generation.current)throw new Error(t('faceRecognition.notReady'))
    return enrollment?{...result,signal}:result
  },[analyzeFrame,enrollment,t])
  useEffect(()=>{onCaptureReady?.(phase==='on'?captureFace:null);return()=>onCaptureReady?.(null)},[onCaptureReady,phase,captureFace])
  const stop = useCallback(() => {
    onWelcomeFrame?.(null)
    captureSession.current?.abort();captureSession.current=null
    generation.current++
    const current = stream.current
    stream.current = null
    current?.getTracks().forEach(track => track.stop())
    if (video.current) video.current.srcObject = null
    setRearLenses([])
    setPhase('off')
  }, [onWelcomeFrame])
  const start = useCallback(async (direction: 'environment' | 'user', requestedLens?: string) => {
    if (openingRequest.current === generation.current) return
    onOpen?.()
    stop(); setError(''); setPhase('opening')
    const request = generation.current
    openingRequest.current = request
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
      const android = /\bAndroid\b/i.test(navigator.userAgent)
      const androidRear = direction === 'environment' && android
      // Android negotiates the sensor format before rotating the preview. Prefer
      // a native photo-shaped frame to avoid selecting a narrower widescreen mode.
      const aspectRatio = androidRear ? 4 / 3 : cameraPortraitScreen() ? 9 / 16 : 16 / 9
      const supported = navigator.mediaDevices.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & { resizeMode?: boolean }) | undefined
      const nativeFrames = supported?.resizeMode
      const devices = navigator.mediaDevices
      const constraints: MediaTrackConstraints = {
        facingMode: { ideal: direction },
        ...(nativeFrames ? { resizeMode: { exact: 'none' }, aspectRatio: { ideal: aspectRatio } } : {}),
      }
      let lens = androidRear ? requestedLens || readRearLens() : ''
      const capture = (deviceId: string) => devices.getUserMedia({audio:false,video:
        deviceId ? {...constraints,deviceId:{exact:deviceId}} : constraints})
      let media: MediaStream
      try { media = await capture(lens) }
      catch (reason) {
        if (!lens || !(reason instanceof Error) || !['NotFoundError','OverconstrainedError','NotReadableError'].includes(reason.name)) throw reason
        if (request !== generation.current || document.hidden) return
        if (readRearLens() === lens) writeRearLens('')
        lens = ''
        media = await capture('')
      }
      if (request !== generation.current || document.hidden) { media.getTracks().forEach(track => track.stop()); return }
      stream.current = media
      captureSession.current=new AbortController()
      media.getVideoTracks().forEach(track => track.addEventListener('ended', stop, { once: true }))
      preview = true
      if (video.current) { video.current.srcObject = media; await video.current.play() }
      if (request === generation.current) {
        setPhase('on')
        if (preferenceScope) writeHomePreference(preferenceScope,'camera',true)
        if (android && !enrollment) {
          const id = androidRear ? media.getVideoTracks()[0]?.getSettings?.().deviceId || lens : ''
          setSelectedLens(id)
          if (lens && requestedLens) writeRearLens(lens)
          void listRearLenses(devices,id).then(ids=>{
            if (request === generation.current) setRearLenses(ids)
          }).catch(()=>{})
        }
      }
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
    } finally {
      if (openingRequest.current === request) openingRequest.current = null
    }
  }, [enrollment, onOpen, preferenceScope, stop, t])
  useEffect(() => {
    if (enabled && autoStart && active) void start(enrollment?'user':'environment')
    const restore = () => {
      if (document.hidden || cameraRestored.current || !enabled || !active || !preferenceScope) return
      cameraRestored.current = true
      if (readHomePreference(preferenceScope,'camera')) {
        void start(readHomePreference(preferenceScope,'frontCamera')?'user':'environment')
      }
    }
    const timer = preferenceScope && enabled && active && !cameraRestored.current ? setTimeout(restore,0) : undefined
    const hide = () => { if (document.hidden) stop(); else restore() }
    document.addEventListener('visibilitychange', hide)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', hide); stop() }
  }, [enabled, autoStart, active, start, stop, projectId, enrollment, preferenceScope])
  const close = () => {
    if (phase === 'on') onManualClose?.()
    cameraRestored.current = true
    if (preferenceScope) writeHomePreference(preferenceScope,'camera',false)
    stop()
    setError('')
  }
  const toggle = () => {
    cameraRestored.current = true
    if (phase === 'off') {
      onManualOpen?.()
      void start(facing)
    }
    else close()
  }

  const prepare = useCallback(async (content: string, onFaces?: CameraFaceCallback) => {
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
      const recent=recentMatch(performance.now())
      context.drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height)
      const annotations=captureFaceAnnotations(faceOverlay.current)
      let facePersonIds:string[]=[],recentFaces=false
      try {
        const frame=await analyzeFrame(canvas)
        if(frame.catalog?.settings.enabled&&includesFaceContext(frame.catalog.settings)){
          const ids=matchedPersonIds(frame.faces)
          const fallback=!ids.length&&recent?.revision===frame.catalog.revision?recent.ids:[]
          const people=await faceApi.context(fallback.length?fallback:ids,frame.faces.filter(face=>!face.person).length)
          facePersonIds=people.people.map(person=>person.person_id)
          recentFaces=fallback.length>0&&facePersonIds.length>0
        }
      } catch { /* Optional recognition must not prevent sending the camera photo. */ }
      if(request!==generation.current||current!==stream.current)throw new Error(t('digitalPerson.cameraNotReady'))
      annotateFaceFrame(canvas,annotations)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(t('digitalPerson.cameraNotReady'))), 'image/jpeg', .85))
      if (request !== generation.current || current !== stream.current) throw new Error(t('digitalPerson.cameraNotReady'))
      const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' })
      const uploaded = await fsApi.uploadImage(file, projectId, 'digital-person-camera')
      if (request !== generation.current || current !== stream.current) throw new Error(t('digitalPerson.cameraNotReady'))
      onFaces?.(facePersonIds,recentFaces||undefined)
      return `${content}\n\n${formatMarkdownAttachment(file, uploaded.url)}`
    } finally { uploading.current = false }
  }, [phase, projectId, t, analyzeFrame, recentMatch])
  useEffect(() => { onPrepare?.(prepare); return () => onPrepare?.(null) }, [onPrepare, prepare])
  const switchButton = phase === 'on' && <CameraSwitch compact={compact || floating} rearLenses={rearLenses} selected={selectedLens} onSwitch={lens => {
    const next = lens === undefined ? (facing === 'environment' ? 'user' : 'environment') : lens ? 'environment' : 'user'
    setFacing(next)
    if (preferenceScope) writeHomePreference(preferenceScope,'frontCamera',next==='user')
    void start(next,lens)
  }}/>
  const overlay = phase === 'on' && !enrollment &&
    <FaceOverlay videoRef={video} overlayRef={faceOverlay} faces={recognition.faces} showNames={recognition.catalog?.settings?.show_names}
      showBoxes={recognition.catalog?.settings?.show_boxes} showRelationship={recognition.catalog?.settings?.show_relationship}/>
  const status = phase === 'on' && !enrollment && (recognition.notice || recognition.loading) &&
    <div className="face-camera-feedback" role="status">
      {recognition.notice || <><Spinner />{t('faceRecognition.loadingModel')}</>}
    </div>
  const preview = <>
    <div className="face-camera-surface">
    <video ref={video} className="digital-person-camera-preview" hidden={phase === 'off'} autoPlay playsInline muted aria-label={t('digitalPerson.cameraPreview')} />
    {phase==='on'&&(enrollment?<FaceOverlay videoRef={video} faces={enrollmentTracking?.face?[enrollmentTracking.face]:[]} showNames={false} enrollmentHolding={enrollmentTracking?.progress!=null}/>:<>{overlay}{status}</>)}
    </div>
    {phase==='on'&&!enrollment&&<span className="face-camera-status face-camera-status--live" role="status">
      {!recognition.notice&&!recognition.loading&&recognition.catalog?.settings.enabled&&<><Spinner size={12}/>{t('faceRecognition.detecting',{count:recognition.faces.length})}</>}
    </span>}
    {error && <p role="alert" className="digital-person-error">{localizeErrorDisplay(error)}</p>}
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
      const homeTop=home.getBoundingClientRect().top
      home.style.setProperty('--home-camera-top',`${anchorBottom-homeTop}px`)
      // The desktop footer owns the absolutely positioned preview.
      home.style.setProperty('--home-camera-container-top',`${footer.getBoundingClientRect().top-homeTop}px`)
      home.style.setProperty('--home-footer-height',`${footer.getBoundingClientRect().height}px`)
    }
    const observer=new ResizeObserver(update)
    for(const element of [footer,info,main,home])observer.observe(element)
    update()
    return()=>{observer.disconnect();home.style.removeProperty('--home-footer-height');home.style.removeProperty('--home-camera-top');home.style.removeProperty('--home-camera-container-top')}
  },[presentation])
  const camera = <div ref={root} style={panelDrag.style} data-camera-moved={Boolean(panelDrag.style)} onPointerDown={panelDrag.onPointerDown} onKeyDown={panelDrag.onKeyDown} className={`digital-person-camera${compact || floating ? ' digital-person-camera--compact' : ''}${floating ? ' digital-person-camera--floating' : ''}${children ? ' digital-person-camera--menu' : ''}${presentation==='panel'?' digital-person-camera--panel':''}`} data-camera-phase={phase} hidden={presentation==='panel'&&phase==='off'&&!error}>
    {!children && <div className="digital-person-camera-actions">
      <Button data-camera-toggle variant="ghost" aria-label={t(phase === 'off' ? 'digitalPerson.openCamera' : 'digitalPerson.closeCamera')} aria-busy={phase === 'opening'} aria-pressed={phase !== 'off'} disabled={!active}
        onClick={toggle}>{phase === 'opening' ? <Spinner size={16} /> : <Icon name="camera" size={floating ? 14 : compact ? 24 : 16} />}{!compact && !floating && t(phase === 'off' ? 'digitalPerson.openCamera' : 'digitalPerson.closeCamera')}</Button>
      {!compact && !floating && !enrollment && switchButton}
    </div>}
    {compact || floating ? <VideoPreviewWindow presentation={presentation} videoRef={video} overlay={overlay} status={status} actions={switchButton} error={error} getAnchor={getAnchor} label={t('digitalPerson.cameraPreview')} closeLabel={t('digitalPerson.closeCamera')} open={phase !== 'off' || Boolean(error)} onClose={close}/> : <div className="digital-person-camera-media">{preview}</div>}
    {presentation==='panel'&&phase==='on'&&cameraPanelEdges.map(edge=><div key={edge} data-camera-resize={edge} className={`camera-panel-resize camera-panel-resize--${edge}`} role="separator" tabIndex={0} aria-label={t(`taskDetail.resize.${edge}` as never)} title={t(`taskDetail.resize.${edge}` as never)}/>)}
  </div>
  if (!children) return camera
  return <DigitalPersonCameraControlContext.Provider value={enabled ? {
    prepare, enabled: phase !== 'off', opening: phase === 'opening', disabled: !active,
    toggle,
  } : null}>{children}{enabled && camera}</DigitalPersonCameraControlContext.Provider>
}

/** Media controls outside the input can share the composer's camera session. */
export function DigitalPersonCameraToggle() {
  const camera = useDigitalPersonCameraControl(), { t } = useI18n()
  const opening = Boolean(camera?.opening)
  const showPending = useDelayedPending(opening)
  if (!camera) return null
  const enabled = camera.enabled && !opening
  const description = t(opening ? 'digitalPerson.homeOpeningCamera' : enabled ? 'digitalPerson.closeCamera' : 'digitalPerson.openCamera')
  return <div className="digital-person-camera digital-person-camera--compact">
    <Button data-camera-toggle variant="ghost" aria-label={t('digitalPerson.homeCamera')} aria-description={description} title={description}
      aria-busy={opening} aria-pressed={enabled} aria-disabled={opening || undefined} disabled={camera.disabled}
      onClick={() => { if (!opening) camera.toggle() }}>
      {showPending ? <Spinner size={16} /> : <Icon name={enabled ? 'camera' : 'camera-off'} size={24} />}
    </Button>
    <span className="digital-home-control-status" role="status">{showPending ? description : ''}</span>
  </div>
}
