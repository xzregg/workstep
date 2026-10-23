export const enterpriseProviders = {
 dingtalk: { name: '钉钉', console: 'https://open-dev.dingtalk.com/' },
 wecom: { name: '企业微信', console: 'https://work.weixin.qq.com/wework_admin/' },
 feishu: { name: '飞书', console: 'https://open.feishu.cn/app' },
 lark: { name: 'Lark', console: 'https://open.larksuite.com/app' },
} as const

export type EnterpriseProvider = keyof typeof enterpriseProviders
export const enterpriseProviderName = (provider: string) =>
 enterpriseProviders[provider as EnterpriseProvider]?.name ?? provider
export const isFeishuProvider = (provider: EnterpriseProvider) => provider === 'feishu' || provider === 'lark'
