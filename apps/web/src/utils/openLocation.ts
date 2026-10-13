import type { Project } from '../api/client'
import { isGatewayRemoteBrowser } from './gatewayRemote'

export function usesWebDirectoryBrowser(
  projectType: Project['type'],
  hostname: string,
  userAgent: string,
  hasDesktopDirectoryBridge = false,
) {
  if (projectType === 'remote' || isGatewayRemoteBrowser()) return true
  if (/\bElectron\//i.test(userAgent)) return !hasDesktopDirectoryBridge
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return !(
    normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0'
    || normalized.startsWith('127.')
  )
}
