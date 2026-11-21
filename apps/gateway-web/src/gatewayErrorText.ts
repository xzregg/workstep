import { translateErrorText } from '../../../packages/gateway-ui/src/errorText'

export function localizeGatewayError<T>(value: T): T | string {
  return typeof value === 'string'
    ? translateErrorText(value, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language)
    : value
}
