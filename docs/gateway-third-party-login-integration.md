# 使用 WorkStep 网关登录第三方系统

接入只需三步：**跳转登录 → 接收 code → 后端兑换用户信息**。无需申请应用 ID 或应用密钥。

## 1. 登记回调地址

请网关超级管理员打开「平台设置 → 第三方登录授权」，添加你的完整回调 URL，例如：

```text
http://business.example.com/auth/workstep/callback
```

支持 HTTP 和 HTTPS，普通域名及 IP 均可。必须与跳转参数中的地址完全一致，包括协议、端口、路径、末尾斜线和固定查询参数；不支持通配符和片段。国际域名请使用 Punycode。回调地址不能预设 `code`、`state`、`request_id` 查询参数。

## 2. 跳转网关登录

第三方后端每次生成两个随机串，与当前浏览器的登录会话关联保存：

| 参数 | 含义 |
|---|---|
| `state` | 本次登录的回调核对值，收到回调时必须校验 |
| `request_id` | 本次登录的流水号，后端兑换时使用 |

推荐两个值分别使用 32 字节安全随机数的 Base64URL 编码，不用递增编号，不重复使用。`request_id` 为 32–128 位 `A–Z a–z 0–9 _ -`；`state` 为 1–256 位 `A–Z a–z 0–9 . _ ~ -`。

引导浏览器访问网关：

```text
https://gateway.example.com/auth/authorize?callback=URL编码后的回调地址&state=随机值&request_id=本次流水号
```

使用 URLSearchParams 等标准工具编码参数，不要直接拼接未编码的 URL。以上三个参数必须各出现一次。

用户已登录网关时自动返回；未登录时先完成网关现有密码或企业扫码登录。未获授权的回调地址会在网关显示错误，不跳往该地址。登录取消、失败可重试；待审批用户需先完成审批，禁用账号不能登录。

## 3. 接收回调并兑换

认证成功，浏览器回到：

```text
http://business.example.com/auth/workstep/callback?code=一次性授权码&state=原始核对值
```

若登记地址已有固定查询参数，则保留并使用 `&` 追加。网关不回传 request_id。

第三方后端先用 `state` 找到当前浏览器对应的未完成登录请求，从后端保存的数据读取 `request_id`。拒绝缺失、重复、不匹配、过期或已完成的 state。不要接受回调请求自行提供的 request_id。

然后由后端请求网关，不需要网关 Cookie：

```http
POST /api/auth/exchange
Content-Type: application/json

{
  "code": "回调收到的授权码",
  "request_id": "该次登录在后端保存的流水号"
}
```

成功响应 `200`：

```json
{
  "user": {
    "id": "稳定的网关用户ID",
    "username": "zhangsan",
    "display_name": "张三"
  }
}
```

使用「网关地址 + user.id」关联本系统账号，账号和显示名用于展示。兑换后清理本次登录上下文并建立自己的会话，浏览器跳转到不含 code 的业务地址。不要把网关 code 当成本系统登录令牌。

## 可复制的 Node.js 示例

[完整示例](examples/gateway-login.mjs) 使用 Node.js 内置模块，无第三方依赖，包含 state/浏览器会话关联和流水号保存。启动前把回调地址加入白名单：

```bash
GATEWAY_URL=https://gateway.example.com \
CALLBACK_URL=http://localhost:8080/callback \
node docs/examples/gateway-login.mjs
```

浏览器打开 `http://localhost:8080/login`。示例用内存保存上下文，重启即清空；正式系统请接入自己的会话存储和登录状态。多实例部署需要共享会话存储。示例不自动绑定本地同名账号。

## 有效期与错误

code 自网关签发后两分钟有效，成功兑换即失效，并发也只会有一次成功。流水号不匹配不会消耗有效 code。回调地址被管理员移除，或用户被禁用后，不能继续兑换。

| HTTP 状态 | 含义 | 处理 |
|---|---|---|
| 400 | code 不存在、过期、已使用或流水号不匹配 | 重新发起登录，检查流水号是否取自对应会话 |
| 403 | 用户或回调授权不可用 | 联系管理员检查账号和白名单 |
| 422 | JSON 字段缺失、格式不正确或传了额外字段 | 检查请求参数 |
| 429 | 请求过于频繁 | 稍后重试 |

沿用网关统一错误结构：

```json
{"error":{"code":"http_error","message":"授权码无效、已使用或已过期，请重新登录。"}}
```

422 的 `error.code` 为 `validation_error`。若兑换超时，结果可能已被消费，应重新登录，不把重试失败解释为用户不存在。

## 接入注意

- code 与 request_id 仅提交给网关兑换接口，不记录到应用日志；代理日志避免保存认证查询参数。
- HTTP 回调按配置允许，HTTP 本身没有传输加密。流水号出现在初始跳转 URL；两个值一起泄露时不能阻止抢先兑换。
- 本接口直接返回基本用户信息，不返回访问令牌、角色、部门或平台权限；不是完整 OAuth 2.0/OIDC 接口。
- 仅支持第三方后端兑换，不开放浏览器跨域调用。

流程图：[第三方登录流程](../plans/gateway-third-party-login.drawio)。
