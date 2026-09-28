# Gateway 开发与部署

Gateway 是独立 FastAPI 服务，`apps/gateway-web` 是独立门户。阶段 0、1 已完成；阶段 2 的本地账号、企业扫码及目录对账 API 已实现，第三方事件回调验签、设备连接与平台授权尚未完成。部署验收以 `plans/platform-gateway-development.md` 为准。

空平台使用 `POST /api/platform/setup` 一次性创建超级管理员及独立恢复管理员，并设置注册模式。`POST /api/auth/register` 遵循 `open`、`open_with_approval` 或 `closed` 策略；`POST /api/auth/login` 返回 CSRF token 并写入安全、HttpOnly Cookie。修改类请求在 `X-CSRF-Token` 传入该 token。登录后的 `POST /api/auth/password`、`POST /api/auth/logout` 管理自身会话；管理员可建号、审核与禁用用户。禁用管理员和重置密码需要先调用 `POST /api/auth/step-up` 以密码确认，确认有效五分钟。重置或禁用会撤销目标用户已有会话。生产访问须用 HTTPS，当前登录 API 尚未与门户页面集成。

超级管理员可在短时二次认证后调用 `POST /api/admin/users/{user_id}/roles` 授予平台或部门范围的 `identity_admin`，也可授予平台范围的 `super_admin`。平台范围的身份管理员可建号和管理用户；部门范围只可管理当前目录中属于指定部门的用户。管理员建号及密码重置后的账号须先修改密码，才能执行管理操作。恢复管理员的创建和登录写入 Gateway 审计表。

超级管理员通过 `POST /api/admin/identity-sources` 登记钉钉或企业微信身份源，凭据只引用服务进程的环境变量名 `secret_env`。钉钉的 `tenant_id` 填企业 CorpId，`client_id` 填应用 AppKey；企业微信的 `tenant_id` 填 CorpID，`agent_id` 填应用 AgentId。`POST /api/auth/external/{source_id}/start` 返回扫码授权 URL；已有 Gateway 会话可调用 `POST /api/auth/external/{source_id}/bind/start` 显式绑定。回调使用一次性 state，并按身份源、企业、稳定 subject 匹配。关闭注册时须先使用管理员目录导入 `POST /api/admin/identity-sources/{source_id}/sync` 预置人员，或由已登录用户显式绑定。`POST /api/admin/identity-sources/{source_id}/events` 幂等应用管理员导入的人员变更，`POST /api/admin/identity-sources/{source_id}/disable` 关闭扫码入口。当前目录导入及事件入口仅供管理员调用。
管理员可调用 `POST /api/admin/identity-sources/{source_id}/reconcile` 从身份源主动拉取部门和人员快照；服务每六小时自动对账，可通过 `WORKSTEP_GATEWAY_DIRECTORY_RECONCILE_SECONDS` 调整。对账失败保留原投影。钉钉主动拉取使用企业内部应用凭据及通讯录读取权限；企业微信应用须能读取可见范围内的部门与人员。第三方事件回调验签尚未接入，不能把第三方事件直接转发到管理员导入入口。

阶段 3A 的 Gateway 授权 API 已开始实现。服务首次启动会在数据目录生成仅服务进程可读的 `gateway-signing-key.pem`，`GET /api/platform/gateway-key` 提供公钥和 SHA-256 指纹；构建受管包时应把对应公钥文件用于固定指纹。设置 `WORKSTEP_GATEWAY_GATEWAY_ID`，与包内的 `gateway_id` 一致。浏览器已登录后调用 `POST /api/desktop/authorize` 获取仅含 code/state 的 `workstep://auth/callback`，Desktop 调用 `POST /api/desktop/token` 用 PKCE 兑换并登记 Ed25519 设备公钥。首次设备为待审批；超级管理员二次认证后调用 `POST /api/admin/devices/{device_id}/approve`，下次授权兑换返回 15 分钟的签名设备授权。
受管 Desktop 使用系统浏览器打开 `/desktop/login`，在主进程内校验回调和固定 Gateway 公钥指纹；设备私钥使用 Electron 系统安全存储加密。审批后，Desktop 把签名设备授权及私钥证明提交给本机 daemon 的 `POST /api/managed/bootstrap`，daemon 校验 Gateway 签名和设备证明，再生成内存中的本机会话。受管模式的业务 HTTP 和 WebSocket 同时要求 Desktop 启动令牌与本机会话，仍在本机 loopback 处理。备份与迁移 Gateway 时须连同数据库保存 `gateway-signing-key.pem`；丢失密钥会使既有受管包公钥指纹不匹配。设备审批页面、会话失效恢复和统一下载页尚未完成。

本地开发使用 `uv run --project apps/gateway --group dev uvicorn gateway.app:app --host 127.0.0.1 --port 8766`。门户在 `apps/gateway-web` 执行 `yarn dev`，开发服务器将 `/api` 代理到 8766。构建后可设置 `WORKSTEP_GATEWAY_WEB_DIST` 为门户 `dist` 的绝对路径，让 Gateway 托管静态文件。默认 SQLite 位于 `~/.workstep-gateway/workstep_platform.db`，可用 `WORKSTEP_GATEWAY_DATA_DIR` 指定数据目录，或用 `WORKSTEP_GATEWAY_DATABASE_URL` 指定 `sqlite+aiosqlite` / `postgresql+asyncpg` 地址。启动执行 Alembic 迁移，未知版本拒绝启动，不会自动退回别的数据库。

SQLite 可在服务运行时执行 `uv run --project apps/gateway python apps/gateway/scripts/backup.py /安全位置/backup.db` 创建一致性备份；PostgreSQL 使用 `pg_dump`。数据库切换必须停机备份、迁移和校验。受管包可用 `apps/desktop` 的 `yarn bundle:managed` 生成签名配置，再用 `yarn dist:managed` 构建；前者需要 `WORKSTEP_GATEWAY_ID`、`WORKSTEP_GATEWAY_ORIGIN`、`WORKSTEP_GATEWAY_PUBLIC_KEY_FILE`、`WORKSTEP_MANAGED_SIGNING_KEY_FILE` 和 `WORKSTEP_MANAGED_BUNDLE_DIR`，后者需要最后一个变量。签名私钥只用于构建，不进入安装包。阶段 1 的受管设备实际连接仍待阶段 3B。

生产环境应为 Gateway 提供独立 HTTPS 域名。阶段 3C 的设备子域代理需要 `d-<device-id>.<gateway-domain>` 的通配符 DNS 和 TLS；当前骨架尚不提供该代理，不应作为受管平台对外部署。

测试：`uv run --project apps/gateway --group dev pytest apps/gateway/tests packages/gateway-protocol/tests`；协议模型变更后运行 `uv run --project apps/gateway python packages/gateway-protocol/scripts/schema.py` 并提交 `schema.json`。门户在 `apps/gateway-web` 运行 `yarn test && yarn build`。
