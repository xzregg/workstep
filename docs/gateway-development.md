# Gateway 开发与部署

Gateway 是独立 FastAPI 服务，`apps/gateway-web` 是独立门户。阶段 0、1 已完成；阶段 2 的本地账号、企业扫码及目录对账 API 已实现，第三方事件回调验签、设备连接与平台授权尚未完成。部署验收以 `plans/platform-gateway-development.md` 为准。

空平台使用 `POST /api/platform/setup` 一次性创建超级管理员及独立恢复管理员，并设置注册模式。`POST /api/auth/register` 遵循 `open`、`open_with_approval` 或 `closed` 策略；`POST /api/auth/login` 返回 CSRF token 并写入安全、HttpOnly Cookie。修改类请求在 `X-CSRF-Token` 传入该 token。登录后的 `POST /api/auth/password`、`POST /api/auth/logout` 管理自身会话；管理员可建号、审核与禁用用户。禁用管理员和重置密码需要先调用 `POST /api/auth/step-up` 以密码确认，确认有效五分钟。重置或禁用会撤销目标用户已有会话。生产访问须用 HTTPS，当前登录 API 尚未与门户页面集成。

超级管理员可在短时二次认证后调用 `POST /api/admin/users/{user_id}/roles` 授予平台或部门范围的 `identity_admin`，也可授予平台范围的 `super_admin`。平台范围的身份管理员可建号和管理用户；部门范围只可管理当前目录中属于指定部门的用户。管理员建号及密码重置后的账号须先修改密码，才能执行管理操作。恢复管理员的创建和登录写入 Gateway 审计表。

超级管理员通过 `POST /api/admin/identity-sources` 登记钉钉或企业微信身份源，凭据只引用服务进程的环境变量名 `secret_env`。钉钉的 `tenant_id` 填企业 CorpId，`client_id` 填应用 AppKey；企业微信的 `tenant_id` 填 CorpID，`agent_id` 填应用 AgentId。`POST /api/auth/external/{source_id}/start` 返回扫码授权 URL；已有 Gateway 会话可调用 `POST /api/auth/external/{source_id}/bind/start` 显式绑定。回调使用一次性 state，并按身份源、企业、稳定 subject 匹配。关闭注册时须先使用管理员目录导入 `POST /api/admin/identity-sources/{source_id}/sync` 预置人员，或由已登录用户显式绑定。`POST /api/admin/identity-sources/{source_id}/events` 幂等应用管理员导入的人员变更，`POST /api/admin/identity-sources/{source_id}/disable` 关闭扫码入口。当前目录导入及事件入口仅供管理员调用。
管理员可调用 `POST /api/admin/identity-sources/{source_id}/reconcile` 从身份源主动拉取部门和人员快照；服务每六小时自动对账，可通过 `WORKSTEP_GATEWAY_DIRECTORY_RECONCILE_SECONDS` 调整。对账失败保留原投影。钉钉主动拉取使用企业内部应用凭据及通讯录读取权限；企业微信应用须能读取可见范围内的部门与人员。第三方事件回调验签尚未接入，不能把第三方事件直接转发到管理员导入入口。

阶段 3A 的 Gateway 授权 API 已开始实现。服务首次启动会在数据目录生成仅服务进程可读的 `gateway-signing-key.pem`，`GET /api/platform/gateway-key` 提供公钥和 SHA-256 指纹；构建受管包时应把对应公钥文件用于固定指纹。设置 `WORKSTEP_GATEWAY_GATEWAY_ID`，与包内的 `gateway_id` 一致。浏览器已登录后调用 `POST /api/desktop/authorize` 获取仅含 code/state 的 `workstep://auth/callback`，Desktop 调用 `POST /api/desktop/token` 用 PKCE 兑换并登记 Ed25519 设备公钥。首次设备为待审批；超级管理员二次认证后调用 `POST /api/admin/devices/{device_id}/approve`，下次授权兑换返回 15 分钟的签名设备授权。
受管 Desktop 使用系统浏览器打开 `/desktop/login`，在主进程内校验回调和固定 Gateway 公钥指纹；设备私钥使用 Electron 系统安全存储加密。审批后，Desktop 把签名设备授权及私钥证明提交给本机 daemon 的 `POST /api/managed/bootstrap`，daemon 校验 Gateway 签名和设备证明，再生成内存中的本机会话。受管模式的业务 HTTP 和 WebSocket 同时要求 Desktop 启动令牌与本机会话，仍在本机 loopback 处理；错误 Origin 被拒绝。本机会话失效时 daemon 返回专用 401 标记，Desktop 单飞重走网关登录与本机交接。超级管理员可在 `/admin/devices` 查看待审批设备，通过密码二次认证批准、停用或撤销。备份与迁移 Gateway 时须连同数据库保存 `gateway-signing-key.pem`；丢失密钥会使既有受管包公钥指纹不匹配。

受管安装包由部署者按网关固定配置构建后放入 Gateway 数据目录的 `releases/`。超级管理员密码二次认证后调用 `POST /api/admin/client-releases`，提交 `os`、`arch`、`version`、`filename`、`minimum_protocol_version`；Gateway 把文件复制为不可变发布副本，计算大小与 SHA-256，并用网关密钥签署规范化清单。`GET /api/client-releases` 和 `/devices/empty` 对所有用户提供同一网关的安装包及校验信息；下载链接不携带用户身份。发布前须核对安装包内的受管配置与本 Gateway ID、公钥 pin 及域名一致，安装包代码签名仍由 Desktop 发布流程负责。

阶段 3B 的控制 WebSocket 已建立 `/api/control/ws` 骨架：Desktop 用设备密钥签署短期控制密钥委托，只把临时控制私钥交给本机 daemon；Gateway 发出一次性随机挑战，由 daemon 的临时密钥应答，并核对签名授权、设备/用户状态和用户设备关系。Gateway 维护单设备在线连接和历史；心跳超时、停用或撤销关闭连接。daemon 主动连接、心跳并退避重连；授权被拒后，本机控制状态通知 Desktop 重新登录。Gateway 在握手和心跳下发十分钟签名策略快照，daemon 校验固定网关公钥、用户/设备、期限和 revision 后缓存并回执；本机状态接口展示期限。完整策略编译、其余受控业务入口门禁和命令传输仍待实现，因此此端点暂不用于生产受管设备。
受管请求的操作者会进入 daemon 的当前身份上下文；共享任务创建服务根据本机签名策略检查 `task.create`，过期、未下发、用户不匹配或能力缺失时返回 403。未分配的受控能力默认拒绝；其余受控入口门禁留待后续阶段，此控制通道尚不适合生产部署。
超级管理员短时二次认证后可调用 `POST /api/admin/capabilities/{user_id}` 授予全局或设备范围的 `task.create`，`effect=deny` 优先于 allow；`POST /api/admin/capabilities/{user_id}/revoke` 撤销相应分配。变更提高目标设备 policy revision，下次控制心跳重签并回传应用版本。设备停用、撤销或账号停用关闭控制连接时，daemon 清空受控策略。项目范围能力和其余受控动作仍待后续阶段。
桌面登录页支持本地密码及已启用的钉钉/企业微信身份源；扫码回调持久化一次性 state 与经过白名单约束的回跳路径，成功后返回原桌面登录页继续签发 code。待审核账号进入等待页。第三方事件回调仍未验签接入，目录变更由定时对账或管理员导入处理。

本地开发使用 `uv run --project apps/gateway --group dev uvicorn gateway.app:app --host 127.0.0.1 --port 8766`。门户在 `apps/gateway-web` 执行 `yarn dev`，开发服务器将 `/api` 代理到 8766。构建后可设置 `WORKSTEP_GATEWAY_WEB_DIST` 为门户 `dist` 的绝对路径，让 Gateway 托管静态文件。默认 SQLite 位于 `~/.workstep-gateway/workstep_platform.db`，可用 `WORKSTEP_GATEWAY_DATA_DIR` 指定数据目录，或用 `WORKSTEP_GATEWAY_DATABASE_URL` 指定 `sqlite+aiosqlite` / `postgresql+asyncpg` 地址。启动执行 Alembic 迁移，未知版本拒绝启动，不会自动退回别的数据库。

SQLite 可在服务运行时执行 `uv run --project apps/gateway python apps/gateway/scripts/backup.py /安全位置/backup.db` 创建一致性备份；PostgreSQL 使用 `pg_dump`。数据库切换必须停机备份、迁移和校验。受管包可用 `apps/desktop` 的 `yarn bundle:managed` 生成签名配置，再用 `yarn dist:managed` 构建；前者需要 `WORKSTEP_GATEWAY_ID`、`WORKSTEP_GATEWAY_ORIGIN`、`WORKSTEP_GATEWAY_PUBLIC_KEY_FILE`、`WORKSTEP_MANAGED_SIGNING_KEY_FILE` 和 `WORKSTEP_MANAGED_BUNDLE_DIR`，后者需要最后一个变量。签名私钥只用于构建，不进入安装包。阶段 1 的受管设备实际连接仍待阶段 3B。

生产环境应为 Gateway 提供独立 HTTPS 域名。阶段 3C 的设备子域代理需要 `d-<device-id>.<gateway-domain>` 的通配符 DNS 和 TLS；当前骨架尚不提供该代理，不应作为受管平台对外部署。

阶段 3C 已提供整机分配的基础接口：超级管理员二次认证后可用 `POST /api/admin/devices/{device_id}/users` 分配用户，或用 `POST /api/admin/devices/{device_id}/users/{user_id}/revoke` 撤销；用户在 `/devices` 查看自己的有效设备。配置 `WORKSTEP_GATEWAY_PUBLIC_ORIGIN=https://gateway.example.com` 后，在线设备的 `GET /api/devices/{device_id}/access` 返回独立子域 URL 与 60 秒 Ed25519 票据，票据绑定用户、设备和目标主机。浏览器向设备子域 `POST /api/remote/redeem` 提交表单票据，一次性兑换主机限定、HttpOnly、Secure 的设备会话；`GET /api/remote/session` 每次重新核对分配和在线状态。迁移 `0012_remote_access` 记录已用票据。数据代理尚未实现，设备子域目前只开放兑换和会话检查，不能据此开放远程工作台。

控制 WSS 可按需发出 `open_data` 命令，PC 随即向 `/api/data/ws` 回连并一次性提交短期 token；控制断开时数据连接随之关闭。

设备子域的 HTTP 和业务 WebSocket 请求现在由 Gateway 校验设备会话、当前分配和在线状态后，按流 ID 经数据 WSS 转发给 PC。PC 在进程内调用已有 FastAPI 应用，注入经过 Gateway 核验的用户身份；HTTP 正文和业务 WebSocket 消息分块传输，Gateway 不转发浏览器 Cookie 或伪造的操作者头。门户“打开电脑”会提交一次性票据，远程 Web 显示设备、用户、在线状态和返回入口。PC 拒绝远程用户执行原生目录/桌面动作及无项目作用域的 FS 浏览，门户给出本机操作提示。完整流控、受管包端到端验收和更多接口边界检查仍待完成，阶段 3C 不可用于生产。

阶段 4A 的供应商控制面 API 已接入：超级管理员先用 `/api/auth/step-up` 确认密码，再用 `POST /api/admin/providers` 创建供应商，`PUT /api/admin/providers/{id}` 更新配置及轮换密钥，`POST /api/admin/providers/{id}/assign` 给用户或设备分配，`POST /api/admin/providers/{id}/assign/revoke` 撤销，`POST /api/admin/providers/{id}/disable` 停用。`GET /api/admin/providers`、`/{id}/assignments`、`/applications` 只返回非敏感目录、分配和设备应用状态。供应商 Key 在 Gateway 数据库中加密，控制连接用设备临时 X25519 公钥封装配置包；PC 校验网关签名、设备、用户、版本与期限，写入本机 `config.json` 并回执。PC 本地文件系统权限持有人仍能读取已下发 Key。配置/策略失效时受管供应商不可用；配置落盘或引擎刷新失败保留上一版本。模型调用授权和管理页面尚未验收。

测试：`uv run --project apps/gateway --group dev pytest apps/gateway/tests packages/gateway-protocol/tests`；协议模型变更后运行 `uv run --project apps/gateway python packages/gateway-protocol/scripts/schema.py` 并提交 `schema.json`。门户在 `apps/gateway-web` 运行 `yarn test && yarn build`。
