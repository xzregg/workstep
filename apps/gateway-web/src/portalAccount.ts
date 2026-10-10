export const passwordRequirements = '密码须为 8–128 位，包含大小写字母、数字、符号中的至少三类，且不能使用常见弱密码或与账号相同。'
const weakPasswords = new Set(['password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123', '123456', '12345678', '123456789', '1234567890', 'admin', 'admin123', 'abc123', 'abc123456', 'abcdef', 'abcdefgh', 'letmein', 'welcome', 'welcome1', 'iloveyou', 'changeme', 'workstep', 'workstep123'])
export function validPortalPassword(username: string, password: string): boolean {
  const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9\s]/].filter(pattern => pattern.test(password)).length
  const plain = password.toLowerCase().replace(/[^a-z0-9]/g, '')
  return password.length >= 8 && password.length <= 128 && categories >= 3
    && password.toLowerCase() !== username.toLowerCase() && !weakPasswords.has(plain) && !/(.)\1{3,}/.test(plain)
}

export type RegistrationMode = 'open' | 'open_with_approval' | 'closed'

export function validPortalAccount(username: string, displayName: string, password: string): boolean {
  return /^[a-z][a-z0-9_-]{2,63}$/.test(username) && !!displayName.trim()
    && displayName.length <= 256 && validPortalPassword(username, password)
}

export function safeNextPath(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\r\n]/.test(value) && !/^\/auth(?:$|[?#])/.test(value) ? value : '/'
}
