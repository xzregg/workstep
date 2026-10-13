import Icon from './Icon'
import {useActiveSkin} from '../skins/runtime'
import {resolvedSkinLayout, type SkinLayout} from '../skins/contract'
import {useCompactLayout} from '../hooks/useCompactLayout'

/** The icon is presentation only; ChatInput retains all state and actions. */
export function ComposerSendIcon({name = 'send'}: {name?: SkinLayout['composerSendIcon']}) {
 return <Icon name={name} size={13} strokeWidth={1.6}/>
}
export default function SkinnedComposerSendIcon() {
 const skin=useActiveSkin(), compact=useCompactLayout()
 return <ComposerSendIcon name={resolvedSkinLayout(skin,compact).composerSendIcon}/>
}
