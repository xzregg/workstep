# 网关第三方登录授权

本批实现：完整回调 URL 白名单、现有网关登录复用、`code + request_id` 一次兑换用户信息。接入方不需要应用 ID、密钥、PKCE 或访问令牌。本协议是 WorkStep 的简化登录接口，不声明 OAuth 2.0/OIDC 兼容。

## 用户流程

1. 超级管理员在「平台设置 → 第三方登录授权」登记完整回调 URL。
2. 第三方后端生成本次 `state` 和 `request_id`，与当前浏览器登录会话关联保存。
3. 浏览器访问 `/auth/authorize?callback=…&state=…&request_id=…`。
4. 网关检查参数及白名单；未登录时转到现有登录页，密码、钉钉等登录完成后恢复该授权请求。
5. 活跃账号直接取得授权码；网关回跳原回调地址，追加 `code` 和 `state`，不回传 `request_id`。
6. 第三方校验 `state`，从自己的后端会话取出流水号，POST `/api/auth/exchange` 提交 `code + request_id`。
7. 网关原子消费 code，返回用户 ID、账号、显示名；第三方建立自己的登录会话。

流程图：[可编辑 draw.io 文件](gateway-third-party-login.drawio)。对外文档：[第三方接入指南](../docs/gateway-third-party-login-integration.md)。

## 配置与接口

- `GET/PUT /api/admin/third-party-auth-settings`：超级管理员读取/保存 `{callback_urls: string[]}`，最多 100 项，默认空；写入沿用 CSRF、管理员二次认证及审计。
- 白名单接受 HTTP/HTTPS 普通域名和 IP，按原始完整字符串精确匹配；路径、端口、协议和固定查询参数均参与匹配。禁止通配符、用户凭据、片段及预设 `code/state/request_id` 查询参数。国际域名使用 ASCII/Punycode 地址。
- `/auth/authorize`：门户路由，自管理校验、登录恢复、签发和外部回跳。参数仅为 `callback/state/request_id`，各出现一次。
- `POST /api/auth/third-party/validate`：登录前检查授权请求及白名单，不签发 code，不需要登录。
- `POST /api/auth/third-party/authorize`：登录会话及 CSRF 保护的签发接口，返回 `{callback_url}`；仅供门户调用。
- `POST /api/auth/exchange`：第三方后端无 Cookie 兑换接口，JSON `{code, request_id}`；返回 `{user: {id, username, display_name}}`。

## 存储与约束

配置复用 `platform_settings`。独立 `third_party_auth_codes` 表保存 code 摘要、request_id 摘要、用户、完整回调、到期时间和消费时间；迁移版本为 `0051_third_party_auth`。

code 使用 32 字节安全随机数生成，有效期两分钟；条件 UPDATE 同时校验摘要、未消费和未过期，保证并发只有一次成功。错误流水号不消费 code。兑换重新检查用户与白名单。删除地址时删除其全部待兑换记录，重新添加地址不会恢复旧 code。签发时清理过期记录。

`request_id` 要求 32–128 位 URL 安全字符，由接入方使用密码学安全随机数生成；示例使用 32 字节随机数的 Base64URL 编码。`state` 为 1–256 位 URL 安全字符，由接入方生成并检查，网关原样回传。request_id 是本次请求关联值，出现在初始跳转 URL 中；不把它描述为 PKCE 或后端独有秘密。

授权响应、兑换响应及其错误禁止缓存，并设置不发送 Referer。签发与兑换复用现有身份限流；审计只记录用户及操作结果，不记录 code 或 request_id。第三方必须后端兑换，不增加跨域浏览器调用能力。新增服务使用异步 SQLAlchemy，不在事件循环执行阻塞 I/O。

## 验证与交付

- 后端行为覆盖配置权限、持久化、HTTP/HTTPS、URL 拒绝、完整地址匹配、无会话/无 CSRF、扫码恢复、流水号错配、过期、禁用、撤销、并发和锁竞争健康检查。
- 前端行为覆盖授权参数、登录上下文保留、错误恢复、回跳地址验证、白名单编辑/关闭保护与保存重试。
- 回归现有门户、企业扫码及桌面授权，运行门户完整测试和构建。
- 手册和真实截图按 AGENTS.md 在本批合并交付节点集中同步；本次未进行合并、提交或发布。
