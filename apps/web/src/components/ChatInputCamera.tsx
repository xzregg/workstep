import { localizeErrorDisplay } from '../i18n'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import DigitalPersonCamera from './digital-person/DigitalPersonCamera'
import { useDigitalPersonCameraControl } from './digital-person/digitalPersonCameraControl'

interface Props {
  projectId?: string
  ownerKey: string
  content: string
  onSend: (content?: string, facePersonIds?:string[], recentFaces?:boolean) => void
  children: (send: () => void) => ReactNode
}

function CameraSend({ content, onSend, children, ownerKey }: Props) {
  const camera = useDigitalPersonCameraControl()
  const sending = useRef(false), generation = useRef(0)
  const [error, setError] = useState('')
  useEffect(() => { const current = ++generation.current; setError(''); return () => { generation.current = current + 1 } }, [ownerKey])
  const send = async () => {
    if (sending.current) return
    if (!camera?.enabled || content.trimStart().startsWith('/')) { setError(''); onSend(); return }
    sending.current = true
    const current = generation.current
    setError('')
    try {
      let facePersonIds:string[]=[],recentFaces:boolean|undefined
      const prepared = await camera.prepare(content,(ids,recent)=>{facePersonIds=ids;recentFaces=recent})
      if (current === generation.current) onSend(prepared,facePersonIds,recentFaces)
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { sending.current = false }
  }
  return <>{children(() => { void send() })}{error && <div className="assistant-chat-error" role="alert">{localizeErrorDisplay(error)}</div>}</>
}

/** One local camera per composer owner; capture precedes the existing send/queue path. */
export default function ChatInputCamera(props: Props) {
  const inherited = useDigitalPersonCameraControl()
  const { can } = useGatewayProjectPermissions(props.projectId)
  if (!props.projectId || !can('file.upload')) return props.children(() => props.onSend())
  if (inherited) return <CameraSend {...props} />
  return <DigitalPersonCamera key={props.ownerKey} projectId={props.projectId} floating><CameraSend {...props} /></DigitalPersonCamera>
}
