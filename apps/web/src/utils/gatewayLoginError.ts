import type { TFunction, TKey } from '../i18n'

export class GatewayLoginFailure extends Error {
 code: string
 fingerprint: string
 constructor(message: string, code = '', fingerprint = '') { super(message); this.code = code; this.fingerprint = fingerprint }
}

const messages: Record<string, TKey> = {
 gateway_key_changed: 'gatewayPlatform.keyChanged', gateway_timeout: 'gatewayPlatform.timeout', gateway_unreachable: 'gatewayPlatform.unreachable',
 gateway_invalid_response: 'gatewayPlatform.invalidResponse', gateway_http_error: 'gatewayPlatform.httpError',
 gateway_not_enabled: 'gatewayPlatform.notEnabled', gateway_package_locked: 'gatewayPlatform.packageLocked',
 gateway_settings_changed: 'gatewayPlatform.settingsChanged',
}

export async function gatewayLoginFailure(response: Response, t: TFunction): Promise<GatewayLoginFailure> {
 const body = await response.json().catch(() => null)
 const detail = body?.detail
 const code = typeof detail?.code === 'string' ? detail.code : ''
 const message = messages[code] ? t(messages[code], {status: detail.status ?? response.status})
  : typeof detail === 'string' ? detail
  : response.status === 403 ? t('gatewayPlatform.permissionDenied') : t('gatewayPlatform.connectError')
 return new GatewayLoginFailure(message, code, typeof detail?.fingerprint === 'string' ? detail.fingerprint : '')
}
