# WebRTC P2P 远程操作协议适配方案

状态：已完成实现、端到端与 Docker 共享镜像验证（分支 `feat/webrtc-p2p`）

## 1. 目标与边界

保留 WorkStep 业务模块与 Gateway 既有控制/数据代理、PKCE 登录、公开分享与门户行为不变，提供一体化的基于 WebRTC DataChannel 的 P2P 直连协议适配链路，同时支持独立部署（`apps/webrtc-signal`）与 Gateway 内置融合启动（`gateway.app:app` + Docker 共享镜像）：

1. **初始协调层（信令 + STUN）**：抽离为独立可复用包 `packages/webrtc-signal`，对外提供标准 FastAPI `APIRouter` 与内置异步 UDP STUN 服务；既可运行在独立零数据库服务 `apps/webrtc-signal`，也可直接内置于 `apps/gateway`（同一服务进程启动即监听信令 HTTP/WS 与 UDP `3478` STUN，并托管 `/p2p/<device_id>/` 工作台）。
2. **纯直连约束（无 TURN 中继）**：不配置任何 TURN 中继。浏览器与 Daemon 双端在 ICE 建连后均强制校验选中候选对（`candidate-pair`）的本地与远端候选均不为 `relay`；一旦发现 `relay` 或探测失败，立即中止并提示原因。
3. **透明协议桥接**：沿用与网关代理一致的 ASGI 进程内桥接机制与 `ProxyFrame` 多路复用模型，将所有工作台 HTTP `/api/*`（含大文件流式上传/下载与背压流控）和 `/ws*` 实时事件流通过 `RTCDataChannel` 直接路由到 Daemon 本地 FastAPI 应用，不修改任何任务、流程、聊天、Git 或引擎业务逻辑。

## 2. 架构设计

```text
手机浏览器 / 移动端 WebView                     Daemon 宿主机
  ├── 初始信令 & STUN ──> [Gateway 内置 (HTTP/WS + UDP STUN) / 独立 apps/webrtc-signal] <── 设备注册 & 信令 ──┤
  │                                                                                                         │
  └── 建连后脱离信令，P2P DataChannel 直传（ICE host/srflx/prflx，禁止 relay） <───────────────────────────┘
        ├── HTTP 多路复用（fetch -> ProxyFrame -> Daemon ASGI）
        └── WebSocket 多路复用（/ws -> ProxyFrame -> Daemon EventBus）
```

### 2.1 通用信令与 STUN（`packages/webrtc-signal` + `apps/webrtc-signal`）

- `stun.py`：基于 `asyncio.DatagramProtocol` 实现 RFC 5389 STUN Binding 服务，返回 `XOR-MAPPED-ADDRESS`（IPv4/IPv6），含格式校验与单 IP 限流。
- `hub.py`：内存态设备注册表（Ed25519 挑战-应答验签防伪造与防重放，支持可选网关设备私钥绑定签名 `workstep-webrtc-gateway-bind-v1`）、配对摘要校验（不接收明文密钥、防爆破限流）、短期会话票据与 SDP/ICE 转发；转发阶段过滤 `typ relay` 候选并拒绝非信令消息。
- `router.py`：`create_webrtc_router(...)` 支持可选外部鉴权钩子，独立部署与 Gateway 均强制设备密钥。
- `apps/webrtc-signal`：零数据库极简启动服务，同时拉起信令 HTTP/WS 端口与 UDP STUN 端口，并托管前端构建产物用于 `/p2p/<device_id>/` 访问。

### 2.2 Daemon 侧协议适配（`apps/daemon/services/webrtc_p2p/`）

- `sdp.py` / `dtls.py` / `sctp.py` / `peer.py`：纯 Python（`aioice` + `pyopenssl` + `cryptography`）实现 `UDP/DTLS/SCTP webrtc-datachannel` 栈，避免引入重型音视频二进制依赖（如 `aiortc`/`av`），兼容 Python 3.12 / 3.14 及桌面/Docker 打包链路。
- 强校验 `verify_direct_candidate_pair()`：核验实际通信候选对双方均不为 `relay`。
- `bridge.py`：复用 `workstep_gateway_protocol.ProxyFrame` 完成流复用、分块传输、`window.update` 背压流控与 `cancel` 取消；支持高吞吐二进制数据帧承载大文件响应体；通过 ASGI `scope["webrtc_remote_actor"]` 在安全守卫中建立合法身份边界，保留对主机原生危险路径的保护。
- `client.py` + `api/webrtc_p2p.py`：管理信令地址、启用开关、配对密钥轮换（配置存 `~/.workstep/config.json`）、后台连接与重连退避，所有阻塞磁盘配置读写均隔离到工作线程；若设备已完成网关平台授权且存在本机网关设备私钥，向信令注册时自动附带网关绑定签名仅用于关联管理后台设备展示。

### 2.3 Gateway 融合、管理后台可见性与 Docker 集成

- **一体化启动（`apps/gateway`）**：`GatewaySettings` 新增 `webrtc_enabled`、`stun_host`、`stun_port`（默认 `3478`）与由数据库恢复的 `stun_urls`（列表，最多 16 个 `stun:` 地址；开箱预置 5 个国内外推荐公共 STUN `DEFAULT_PUBLIC_STUN_URLS`，清空则仅用网关内置 STUN），移除 `WORKSTEP_GATEWAY_STUN_PUBLIC_HOST` / `WORKSTEP_GATEWAY_STUN_PUBLIC_PORT` 启动环境变量；管理员可在「管理后台 → 平台设置 → 平台信息」通过 `PUT /api/admin/webrtc-stun`（服务层 `services/webrtc_stun_settings.py` 持久化到 `PlatformSetting` key `'webrtc_stun_urls'` 并记录审计）与 `AdminWebRtcStunDialog.tsx` 配置多个公共 STUN 服务器（支持一键恢复默认推荐与清空），保存后立即生效。`gateway.app:create_app` 在 `lifespan` 启动 `StunServer` 并恢复持久化 STUN 配置，挂载 `create_webrtc_router`，并注册 `/p2p/{device_id}` 与 `/p2p/{device_id}/{fullpath:path}` 复用 `workspace_web_dist`（静态资源前缀 `/workspace-assets/`，零路径冲突，不改变原 Gateway 控制/数据/分享路由）。
- **多 STUN 并发探测与网络/局内 IP 变化自动重连**：
  - `POST /api/webrtc/pair` 签发会话时固定服务端当前 `stun_urls` 并在 `offer` / `ice_restart` 信令中同步下发给在线 Daemon（剥离客户端伪造字段）；Daemon 侧 `peer.py::select_reachable_stun_server()` 并发向多个 STUN 发送 RFC 5389 Binding 探测包，择优选择最快可达节点后再收集候选。
  - **三层网络/IP 变化恢复**：① 浏览器 `peerClient.ts` 对 `iceConnectionState === 'disconnected'` 提供 4 秒瞬断自愈窗口（恢复到 `connected`/`completed` 即不断开）；② Daemon `client.py::_heartbeat` 基于 `pong` 接收时间戳触发心跳超时主动关闭半开死连接，从而在宿主机局内/公网 IP 变更后立即重连信令；③ `WebRtcRemoteFrame.tsx` 遇到意外断连时保留已挂载工作台 DOM 不销毁，进入 `reconnecting` 原位指数退避自动重连（`1s → 2s → 4s → 8s`，并监听 `online`、`visibilitychange`、`workstep:resume` 与 `navigator.connection` `change`）。当连接看似仍 `open` 但网络变动导致底层静默失效时，立即通过 `transportAdapter.ts::ping()` 发起 1500ms 主动 `p2p.ping`/`p2p.pong` 探针，超时即触发无感原位重连并在恢复后派发 `workstep:resume`；日常每 10 秒自动测量实时 RTT，在顶部连接栏（桌面与手机视口均显示）和侧栏状态 `GatewayConnectionStatus` 中按网关同款规范展示 `· XX ms` 与延迟分档颜色（`<500ms` 正常、`500–1000ms` 警告、`>1000ms` 缓慢）。
- **本机密钥鉴权**：所有浏览器（包括网关管理员）均须输入设备本机生成的配对密钥；信令只验证加盐摘要，直连后由本机再次校验密钥，票据或账号权限不能替代。密钥仅本机可查看／轮换，轮换关闭已有会话。

### 2.4 Web 前端适配（`apps/web`）

- 路由入口：`/p2p/<device_id>/...` 由 `WebRtcRemoteFrame` 托管解锁配对（始终要求本机配对密钥）、纯直连状态检查、ICE 重启（网络切换/切后台恢复）及顶部连接状态条。
- 传输层：`transportAdapter.ts` 在 P2P 活跃时拦截同源 Daemon 请求（排除 `/api/webrtc/*`、`/assets/*` 与 `/workspace-assets/*`）与 `/ws*` 连接，流式响应使用 `ReadableStream` + 信用窗口实现低内存占用文件传输。
- 设置入口：在「设置 → 远程访问」新增「WebRTC 直连」标签页（`WebRtcP2pSettings`），提供启用开关、信令地址配置、配对密钥显隐/轮换及移动入口链接复制。

## 3. 验收标准

1. `packages/webrtc-signal`、`apps/gateway`、`apps/daemon`、`apps/desktop`、`apps/web` 与 `apps/gateway-web` 单元测试、慢 I/O Canary 及打包检查全部通过。
2. 真实无头 Chromium ↔ Gateway（`gateway.app:create_app` 含信令、UDP STUN、`/p2p/<device_id>/` 与管理员仍须配对密钥直连）↔ 真实 `apps/daemon` 端到端链路验证通过。
3. `apps/web`（`yarn build`、`yarn build:gateway-share`）与 `apps/gateway-web`（`yarn build`）编译通过；管理后台设备页与工作台在 `320px/390px/1023px/1024px/1440px` 多视口渲染检查无溢出与错位。
4. 实际构建 `workstep:latest` Docker 镜像并在隔离空 Home 下通过 `scripts/verify-shared-image.py` 及真实 UDP STUN 响应检查，仓库健康检查与密钥扫描通过。
