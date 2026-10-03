export type RegistrationMode = 'open' | 'open_with_approval' | 'closed'

export function validPortalAccount(username: string, displayName: string, password: string): boolean {
  return /^[a-z][a-z0-9_-]{2,63}$/.test(username) && !!displayName.trim()
    && displayName.length <= 256 && password.length >= 12 && password.length <= 128
}

export function safeNextPath(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\r\n]/.test(value) && !/^\/auth(?:$|[?#])/.test(value) ? value : '/'
}
