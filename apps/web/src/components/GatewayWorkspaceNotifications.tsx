import { NotificationCenterView } from '@workstep/gateway-ui/NotificationCenterView'
import { openRemoteAccess } from '@workstep/gateway-ui/openRemoteAccess'
import '@workstep/gateway-ui/NotificationCenter.css'

export default function GatewayWorkspaceNotifications() {
 return <NotificationCenterView onOpen={(_,access)=>openRemoteAccess(access)}/>
}
