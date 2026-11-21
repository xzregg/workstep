import Icon from './Icon'
import {useActiveSkin} from '../skins/runtime'
import {resolvedSkinLayout, type SkinLayout} from '../skins/contract'
import {useCompactLayout} from '../hooks/useCompactLayout'

/** The icon is presentation only; ChatInput retains all state and actions. */
type SendIconSize = {size?:number;strokeWidth?:number}

export function ComposerSendIcon({name = 'send',size=13,strokeWidth=1.6}: SendIconSize & {name?: SkinLayout['composerSendIcon']}) {
 if (typeof name !== 'string') return <svg focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name.paths.map((path,index)=><path key={index} d={path}/>)}</svg>
 return <Icon name={name} size={size} strokeWidth={strokeWidth}/>
}
export default function SkinnedComposerSendIcon(props:SendIconSize) {
 const skin=useActiveSkin(), compact=useCompactLayout()
 return <ComposerSendIcon {...props} name={resolvedSkinLayout(skin,compact).composerSendIcon}/>
}
