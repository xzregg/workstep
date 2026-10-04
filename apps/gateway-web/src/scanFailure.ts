export function scanFailureMessage(value: string | null): string {
  switch (value) {
    case 'cancelled': return '扫码登录已取消，可重新扫码或使用密码登录。'
    case 'expired': return '扫码登录已过期，请重新扫码。'
    case 'unavailable': return '身份源暂时不可用，请稍后重试或使用密码登录。'
    case 'denied': return '此企业身份无法登录，请联系管理员或使用密码登录。'
    default: return ''
  }
}
