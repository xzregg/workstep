import { useRef, useState } from 'react'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import FloatingMenu, { useFloatingMenu } from './FloatingMenu'

export default function ChatWindowMenu({ layout, onChange, onAdd, canAdd }: {
  layout: 'horizontal' | 'vertical'
  onChange: (layout: 'horizontal' | 'vertical') => void
  onAdd: () => void
  canAdd: boolean
}) {
  const { t } = useI18n()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useFloatingMenu()
  const [arranging, setArranging] = useState(false)
  return <>
    <Button ref={trigger} className="chat-window-trigger" variant="ghost" size="sm"
      aria-label={t('chatWorkspace.title')} aria-haspopup="dialog" aria-expanded={Boolean(menu.anchor)}
      onClick={() => {
        if (menu.anchor) menu.close()
        else { setArranging(false); menu.openFrom(trigger.current) }
      }}>
      {t('chatWorkspace.title')}<Icon name="chevron-down" size={12} />
    </Button>
    {menu.anchor && <FloatingMenu anchor={menu.anchor} triggerRef={trigger} side="bottom" width={150}
      title={t(arranging ? 'chatWorkspace.arrange' : 'chatWorkspace.title')} value={arranging ? layout : ''}
      options={arranging ? [
        { value: 'horizontal', label: t('chatWorkspace.horizontal') },
        { value: 'vertical', label: t('chatWorkspace.vertical') },
      ] : [
        { value: 'add', label: t('chatWorkspace.add'), disabled: !canAdd },
        { value: 'arrange', label: t('chatWorkspace.arrange'), keepOpen: true },
      ]} onSelect={value => {
        if (value === 'arrange') setArranging(true)
        else if (value === 'add') onAdd()
        else if (value === 'horizontal' || value === 'vertical') onChange(value)
      }} onClose={menu.close} />}
  </>
}
