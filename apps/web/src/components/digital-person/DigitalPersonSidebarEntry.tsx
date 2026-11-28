import { useContext } from 'react'
import type { Project } from '../../api/client'
import { useGatewayProjectPermissions } from '../../hooks/useGatewayProjectPermissions'
import { useI18n } from '../../i18n'
import { NavigationDismissContext } from '../NavigationDismissContext'
import DigitalPersonChatButton from './DigitalPersonChatButton'
import { useDigitalPerson } from './useDigitalPerson'
import './DigitalPersonSidebarEntry.css'

export default function DigitalPersonSidebarEntry({ project, rail = false, header = false }: { project: Project; rail?: boolean; header?: boolean }) {
  const { bound } = useGatewayProjectPermissions(project.id)
  const profile = useDigitalPerson(Boolean(project.is_default_workspace && project.type !== 'remote' && !bound))
  const dismiss = useContext(NavigationDismissContext)
  const { t } = useI18n()
  if (!profile) return null
  return <DigitalPersonChatButton workspace={project} onClose={dismiss} sidebar rail={rail} header={header}
    label={header ? t('digitalPerson.title') : t('digitalPerson.chatWith', {name:profile.name})} />
}
