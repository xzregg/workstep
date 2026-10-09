import { NotificationCenterView } from './NotificationCenterView'
import { openRemoteAccess } from './openRemoteAccess'
export type { GatewayNotice,NotificationTarget } from './NotificationCenterView'

export function NotificationCenter() {
  return <NotificationCenterView onOpen={(_,access)=>openRemoteAccess(access)}/>
}
