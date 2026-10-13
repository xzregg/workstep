import Icon from './Icon'
import {useActiveSkin} from '../skins/runtime'
import {resolvedSkinLayout, type SkinLayout} from '../skins/contract'
import {useCompactLayout} from '../hooks/useCompactLayout'

/** The icon is presentation only; ChatInput retains all state and actions. */
export function ComposerSendIcon({name = 'send'}: {name?: SkinLayout['composerSendIcon']}) {
 if (typeof name !== 'string') return <svg focusable="false" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name.paths.map((path,index)=><path key={index} d={path}/>)}</svg>
 return <Icon name={name} size={13} strokeWidth={1.6}/>
}
export default function SkinnedComposerSendIcon() {
 const skin=useActiveSkin(), compact=useCompactLayout()
 return <ComposerSendIcon name={resolvedSkinLayout(skin,compact).composerSendIcon}/>
}
