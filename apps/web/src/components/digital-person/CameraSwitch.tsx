import { useRef } from 'react'
import { useI18n } from '../../i18n'
import Button from '../Button'
import FloatingMenu, { useFloatingMenu } from '../FloatingMenu'
import Icon from '../Icon'

export default function CameraSwitch({compact, rearLenses, selected, onSwitch}: {
  compact: boolean
  rearLenses: string[]
  selected: string
  onSwitch: (rearLens?: string) => void
}) {
  const { t } = useI18n()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useFloatingMenu()
  const label = t('digitalPerson.switchCamera')
  const multiple = rearLenses.length > 1
  return <>
    <Button ref={trigger} className="digital-person-camera-switch" variant="ghost" aria-label={label} title={label}
      aria-haspopup={multiple ? 'dialog' : undefined} aria-expanded={multiple ? Boolean(menu.anchor) : undefined}
      onClick={() => {
        if (!multiple) onSwitch()
        else if (menu.anchor) menu.close()
        else menu.openFrom(trigger.current)
      }}>{compact ? <Icon name="switch-camera" size={14} /> : label}</Button>
    {multiple && menu.anchor && <FloatingMenu anchor={menu.anchor} triggerRef={trigger} side="bottom"
      title={label} value={selected} options={[
        ...rearLenses.map((id, index) => ({value:id,label:t('digitalPerson.rearCameraLens',{number:index+1})})),
        {value:'',label:t('digitalPerson.frontCameraLens')},
      ]} onSelect={value => {if (value !== selected) onSwitch(value)}} onClose={menu.close}/>}
  </>
}
