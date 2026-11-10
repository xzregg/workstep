import Button, { type ButtonProps } from './Button'
import Icon from './Icon'

export default function SidebarAddButton(props: ButtonProps) {
  return <Button {...props} variant="icon" size="sm" className="sidebar-add-button">
    <Icon name="plus" size={9.6} strokeWidth={2} />
  </Button>
}
