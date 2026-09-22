# WorkStep WeChat Bridge

WorkStep 的微信渠道桥接侧车（JSONL over wechaty）。Daemon 通过
`SubprocessWeChatBridge` 以子进程方式启动本目录下的 `index.js`，二者用
单行 JSON 协议（stdin 命令 / stdout 事件）通信，实现扫码登录、消息收发与
登录态保持。

## 运行要求

- Node.js >= 18
- 安装依赖（首次使用前执行一次）：

  ```bash
  cd apps/wechat-bridge
  npm install
  # 可选：按需更换 puppet，例如 puppet-wechat4（默认）
  npm i puppet-wechat4
  ```

- 环境变量：
  - `WECHATY_PUPPET`：wechaty puppet，默认 `puppet-wechat4`
  - `WECHATY_NAME`：bot 名称，默认 `workstep`

## 协议

- 命令（daemon → stdin）：`start` / `login` / `logout` / `send_text` / `stop`
- 事件（stdout → daemon）：`qr_code` / `login` / `logout` / `message` / `error`

默认通过 `WORKSTEP_WECHAT_BRIDGE_COMMAND` 未设置时，daemon 会自动使用本目录：
`node <repo>/apps/wechat-bridge/index.js`。

> 提示：不同 wechaty puppet 的登录实现与可用性不同（个人微信 web 协议受
> 官方限制）。生产环境请选用与你的网络/账号环境匹配的 puppet，并在真实
> 环境完成端到端验证。
