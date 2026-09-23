import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'

export default function MobileOpenLocationButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <Button variant="ghost" disabled={disabled} onClick={onClick} style={{ justifyContent: 'flex-start', gap: 8 }}>
      <Icon name="folder" size={16} /> {t('taskList.openLocation')}
    </Button>
  )
}
