# Gateway 开发与部署

生产部署、DNS/TLS、备份恢复、密钥与客户端回滚步骤见 [Gateway 运维手册](gateway-operations.md)。

Gateway 是独立 FastAPI 服务，`apps/gateway-web` 是独立门户。阶段 0、1 已完成，后续阶段仍在开发与验收。部署验收以 `plans/platform-gateway-development.md` 为准。

空平台使用 `POST /api/platform/setup` 一次性创建超级管理员及独立恢复管理员，并设置注册模式。`POST /api/auth/register` 遵循 `open`、`open_with_approval` 或 `closed` 策略；`POST /api/auth/login` 返回 CSRF token 并写入安全、HttpOnly Cookie。修改类请求在 `X-CSRF-Token` 传入该 token。登录后的 `POST /api/auth/password`、`POST /api/auth/logout` 管理自身会话；管理员可建号、审核与禁用用户。禁用管理员和重置密码需要先调用 `POST /api/auth/step-up` 以密码确认，确认有效五分钟。重置或禁用会撤销目标用户已有会话。生产访问须用 HTTPS；门户 `/auth` 和 `/account` 已接入初始化、注册、登录、改密与注销。

超级管理员可在短时二次认证后调用 `POST /api/admin/users/{user_id}/roles` 授予平台或部门范围的 `identity_admin`，也可授予平台范围的 `super_admin`。平台范围的身份管理员可建号和管理用户；部门范围只可管理当前目录中属于指定部门的用户。管理员建号及密码重置后的账号须先修改密码，才能执行管理操作。恢复管理员的创建和登录写入 Gateway 审计表。 新增 `org_admin`（身份源或全组织）、`department_admin`（部门可递归）、`device_admin`（显式设备组或全设备）和范围只读的 `audit_admin`；原身份、Skills 管理员继续有效。设备部门与设备组在 `/admin/device-groups` 由超管设置，未归属设备不推断所属部门。组织管理员只能委派本组织部门范围的身份、部门与审计角色；部门管理员按用户、设备与项目范围管理内容授权和供应商分配。管理角色不产生普通内容访问权；供应商全局配置仍为超管专属，分级管理员使用 `/api/admin/providers/assignment-catalog` 安全目录。

超级管理员通过 `POST /api/admin/identity-sources` 登记钉钉或企业微信身份源，凭据只引用服务进程的环境变量名 `secret_env`。钉钉的 `tenant_id` 填企业 CorpId，`client_id` 填应用 AppKey；企业微信的 `tenant_id` 填 CorpID，`agent_id` 填应用 AgentId。`POST /api/auth/external/{source_id}/start` 返回扫码授权 URL；已有 Gateway 会话可调用 `POST /api/auth/external/{source_id}/bind/start` 显式绑定。回调使用一次性 state，并按身份源、企业、稳定 subject 匹配。关闭注册时须先使用管理员目录导入 `POST /api/admin/identity-sources/{source_id}/sync` 预置人员，或由已登录用户显式绑定。`POST /api/admin/identity-sources/{source_id}/events` 幂等应用管理员导入的人员变更，`POST /api/admin/identity-sources/{source_id}/disable` 关闭扫码入口。当前目录导入及事件入口仅供管理员调用。
管理员可调用 `POST /api/admin/identity-sources/{source_id}/reconcile` 从身份源主动拉取部门和人员快照；服务每六小时自动对账，可通过 `WORKSTEP_GATEWAY_DIRECTORY_RECONCILE_SECONDS` 调整。对账失败保留原投影。钉钉主动拉取使用企业内部应用凭据及通讯录读取权限；企业微信应用须能读取可见范围内的部门与人员。启用厂商事件回调时，同时在创建身份源请求中填写 `callback_token_env` 和 `callback_aes_key_env`，其值为服务进程中的环境变量名；不把 Token 或 AES Key 写入数据库。将厂商回调地址设为 `/api/auth/external/{source_id}/events`。钉钉使用加密 JSON POST，企业微信使用 GET URL 验证及加密 XML POST。入口验签、解密和校验身份源后，将目录变更触发记录持久化并快速回应；后台立即对账，失败每分钟重试且重启后继续。重复事件依据解密正文去重。真实厂商联调尚未验收。

阶段 3A 的 Gateway 授权 API 已开始实现。服务首次启动会在数据目录生成仅服务进程可读的 `gateway-signing-key.pem`，`GET /api/platform/gateway-key` 提供公钥和 SHA-256 指纹；构建受管包时应把对应公钥文件用于固定指纹。设置 `WORKSTEP_GATEWAY_GATEWAY_ID`，与包内的 `gateway_id` 一致。浏览器已登录后调用 `POST /api/desktop/authorize` 获取仅含 code/state 的 `workstep://auth/callback`，Desktop 调用 `POST /api/desktop/token` 用 PKCE 兑换并登记 Ed25519 设备公钥。首次设备为待审批；超级管理员二次认证后调用 `POST /api/admin/devices/{device_id}/approve`，下次授权兑换返回 15 分钟的签名设备授权。
受管 Desktop 使用系统浏览器打开 `/desktop/login`，在主进程内校验回调和固定 Gateway 公钥指纹；设备私钥使用 Electron 系统安全存储加密。审批后，Desktop 把签名设备授权及私钥证明提交给本机 daemon 的 `POST /api/managed/bootstrap`，daemon 校验 Gateway 签名和设备证明，再生成内存中的本机会话。受管模式的业务 HTTP 和 WebSocket 同时要求 Desktop 启动令牌与本机会话，仍在本机 loopback 处理；错误 Origin 被拒绝。本机会话失效时 daemon 返回专用 401 标记，Desktop 单飞重走网关登录与本机交接。超级管理员可在 `/admin/devices` 查看待审批设备，通过密码二次认证批准、停用或撤销。备份与迁移 Gateway 时须连同数据库保存 `gateway-signing-key.pem`；丢失密钥会使既有受管包公钥指纹不匹配。

受管安装包由部署者按网关固定配置构建后放入 Gateway 数据目录的 `releases/`。超级管理员密码二次认证后调用 `POST /api/admin/client-releases`，提交 `os`、`arch`、`version`、`filename`、`minimum_protocol_version`；Gateway 把文件复制为不可变发布副本，计算大小与 SHA-256，并用网关密钥签署规范化清单。`GET /api/client-releases` 和 `/devices/empty` 对所有用户提供同一网关的安装包及校验信息；下载链接不携带用户身份。发布前须核对安装包内的受管配置与本 Gateway ID、公钥 pin 及域名一致，安装包代码签名仍由 Desktop 发布流程负责。

阶段 3B 的控制 WebSocket 已建立 `/api/control/ws` 骨架：Desktop 用设备密钥签署短期控制密钥委托，只把临时控制私钥交给本机 daemon；Gateway 发出一次性随机挑战，由 daemon 的临时密钥应答，并核对签名授权、设备/用户状态和用户设备关系。Gateway 维护单设备在线连接和历史；心跳超时、停用或撤销关闭连接。daemon 主动连接、心跳并退避重连；授权被拒后，本机控制状态通知 Desktop 重新登录。Gateway 在握手和心跳下发十分钟签名策略快照，daemon 校验固定网关公钥、用户/设备、期限和 revision 后缓存并回执；本机状态接口展示期限。完整策略编译、其余受控业务入口门禁和命令传输仍待实现，因此此端点暂不用于生产受管设备。
受管请求的操作者会进入 daemon 的当前身份上下文；共享任务创建服务根据本机签名策略检查 `task.create`，过期、未下发、用户不匹配或能力缺失时返回 403。未分配的受控能力默认拒绝；其余受控入口门禁留待后续阶段，此控制通道尚不适合生产部署。
超级管理员短时二次认证后可调用 `POST /api/admin/capabilities/{user_id}` 授予全局或设备范围的 `task.create`，`effect=deny` 优先于 allow；`POST /api/admin/capabilities/{user_id}/revoke` 撤销相应分配。变更提高目标设备 policy revision，下次控制心跳重签并回传应用版本。设备停用、撤销或账号停用关闭控制连接时，daemon 清空受控策略。项目范围能力和其余受控动作仍待后续阶段。
桌面登录页支持本地密码及已启用的钉钉/企业微信身份源；扫码回调持久化一次性 state 与经过白名单约束的回跳路径，成功后返回原桌面登录页继续签发 code，失败后携带有限错误状态返回重试。待审核账号进入等待页。

阶段 4D 的 Gateway 组 API 在 `/api/groups`；外部部门映射组跟随目录同步，组项目关系仅授予 Skills 管理范围。`/api/admin/skills` 接收限额 ZIP 包并保存不可变版本，具有平台范围 `skill_admin` 或超级管理员角色且完成短时密码二次认证后才能上传、审核和授权版本；组长只能给本组已关联项目分配获授权的固定版本。设备控制心跳携带签名清单，PC 从固定网关按需下载并验签、校验包摘要和路径后落盘；`/api/admin/skills/applications` 可看项目应用状态。管理页面仍待完成。

本地开发使用 `uv run --project apps/gateway --group dev uvicorn gateway.app:app --host 0.0.0.0 --port 8766`。门户在 `apps/gateway-web` 执行 `yarn dev`，开发服务器将 `/api` 代理到 8766。构建后可设置 `WORKSTEP_GATEWAY_WEB_DIST` 为门户 `dist` 的绝对路径，让 Gateway 托管静态文件。默认 SQLite 位于 `~/.workstep-gateway/workstep_platform.db`，可用 `WORKSTEP_GATEWAY_DATA_DIR` 指定数据目录，或用 `WORKSTEP_GATEWAY_DATABASE_URL` 指定 `sqlite+aiosqlite` / `postgresql+asyncpg` 地址。启动执行 Alembic 迁移，未知版本拒绝启动，不会自动退回别的数据库。

SQLite 可在服务运行时执行 `uv run --project apps/gateway python apps/gateway/scripts/backup.py /安全位置/backup.db` 创建一致性备份；PostgreSQL 使用 `pg_dump`。数据库切换必须停机备份、迁移和校验。受管包可用 `apps/desktop` 的 `yarn bundle:managed` 生成签名配置，再用 `yarn dist:managed` 构建；前者需要 `WORKSTEP_GATEWAY_ID`、`WORKSTEP_GATEWAY_ORIGIN`、`WORKSTEP_GATEWAY_PUBLIC_KEY_FILE`、`WORKSTEP_MANAGED_SIGNING_KEY_FILE` 和 `WORKSTEP_MANAGED_BUNDLE_DIR`，后者需要最后一个变量。签名私钥只用于构建，不进入安装包。阶段 1 的受管设备实际连接仍待阶段 3B。

生产环境应为 Gateway 提供独立 HTTPS 域名。阶段 3C 的设备子域代理需要 `d-<device-id>.<gateway-domain>` 的通配符 DNS 和 TLS；数据代理已实现，生产验收仍以逐阶段计划为准。

本机验收可使用 HTTP：`http://localhost:8700`、回环 IP（如 `http://127.0.0.1:8700`、`http://[::1]:8700`）及 `.localhost` 子域。Gateway、受管包构建/验签、Desktop 登录与 daemon 连接共用这一规则；非回环地址仍要求 HTTPS。HTTP 使用 HttpOnly、SameSite Cookie，保留 CSRF 校验；HTTPS 的 Cookie 保留 Secure。设备票据绑定完整主机和端口，回环 IP 对应的设备入口生成 `d-<device-id>.localhost:8700`，控制和数据连接使用 WS，页面跳转与返回链接保留端口。

8700 本机服务使用独立数据目录 `~/.workstep-gateway-acceptance/8700`。先在 `apps/gateway-web` 执行 `yarn build`，在 `apps/web` 执行 `yarn build:gateway-share`，再从仓库根目录启动：

```bash
WORKSTEP_GATEWAY_DATA_DIR="$HOME/.workstep-gateway-acceptance/8700" \
WORKSTEP_GATEWAY_PUBLIC_ORIGIN=http://localhost:8700 \
WORKSTEP_GATEWAY_GATEWAY_ID=local-acceptance-8700 \
WORKSTEP_GATEWAY_PORT=8700 \
WORKSTEP_GATEWAY_WEB_DIST="$PWD/apps/gateway-web/dist" \
WORKSTEP_GATEWAY_WORKSPACE_WEB_DIST="$PWD/apps/web/dist-gateway-share" \
uv run --project apps/gateway --no-sync uvicorn gateway.app:app --host 0.0.0.0 --port 8700
```

打开 `http://localhost:8700/auth`；新数据目录需要先初始化管理员。相关行为测试：Gateway `test_local_gateway_origin.py` / `test_data_http.py`、daemon `test_gateway_local_origin.py`、Desktop `gateway-origin.test.cjs` / `managed-config.test.cjs`、Web `gatewayRemoteFrame.test.tsx`。

阶段 3C 已提供整机分配的基础接口：超级管理员二次认证后可用 `POST /api/admin/devices/{device_id}/users` 分配用户，或用 `POST /api/admin/devices/{device_id}/users/{user_id}/revoke` 撤销；用户在 `/devices` 查看自己的有效设备。配置 `WORKSTEP_GATEWAY_PUBLIC_ORIGIN=https://gateway.example.com` 后，在线设备的 `GET /api/devices/{device_id}/access` 返回独立子域 URL 与 60 秒 Ed25519 票据，票据绑定用户、设备和目标主机。浏览器向设备子域 `POST /api/remote/redeem` 提交表单票据，一次性兑换主机限定、HttpOnly、Secure 的设备会话；`GET /api/remote/session` 每次重新核对分配和在线状态。迁移 `0012_remote_access` 记录已用票据。设备会话通过验证后才允许进入数据代理；完整远程工作台验收仍待完成。

控制 WSS 可按需发出 `open_data` 命令，PC 随即向 `/api/data/ws` 回连并一次性提交短期 token；控制断开时数据连接随之关闭。

设备子域的 HTTP 和业务 WebSocket 请求现在由 Gateway 校验设备会话、当前分配和在线状态后，按流 ID 经数据 WSS 转发给 PC。PC 在进程内调用已有 FastAPI 应用，注入经过 Gateway 核验的用户身份；HTTP 正文和业务 WebSocket 消息分块传输，Gateway 不转发浏览器 Cookie 或伪造的操作者头。门户“打开电脑”会提交一次性票据，远程 Web 显示设备、用户、在线状态和返回入口。项目会话现在也经该数据通道加载宿主的完整 WorkStep Web，不再由门户复制任务列表/详情；首次只读取绑定项目摘要，进入原任务工作台，任务详情复用 `TaskDetailPage`，项目授权设置复用现有授权展示模块。PC 拒绝远程用户执行原生目录/桌面动作及无项目作用域的 FS 浏览，门户给出本机操作提示。完整流控、受管包端到端验收和更多接口边界检查仍待完成，阶段 3C 不可用于生产。

阶段 4A 的供应商控制面 API 已接入：超级管理员先用 `/api/auth/step-up` 确认密码，再用 `POST /api/admin/providers` 创建供应商，`PUT /api/admin/providers/{id}` 更新配置及轮换密钥，`POST /api/admin/providers/{id}/assign` 给用户或设备分配，`POST /api/admin/providers/{id}/assign/revoke` 撤销，`POST /api/admin/providers/{id}/disable` 停用。`GET /api/admin/providers`、`/{id}/assignments`、`/applications` 只返回非敏感目录、分配和设备应用状态。供应商 Key 在 Gateway 数据库中加密，控制连接用设备临时 X25519 公钥封装配置包；PC 校验网关签名、设备、用户、版本与期限，写入本机 `config.json` 并回执。PC 本地文件系统权限持有人仍能读取已下发 Key。配置/策略失效时受管供应商不可用；配置落盘或引擎刷新失败保留上一版本。远程请求携带当前访问用户的供应商授权及五分钟有效期；PC 同时校验本机有效策略和访问用户的供应商范围。轻量 HTTP 调用重新校验当前凭据和模型目录，撤权或密钥轮换后的缓存配置不可继续使用。无法接入平台供应商的原生凭据引擎在受管模式下拒绝调用。

阶段 4B 的超级管理员在密码二次认证后可用 `POST /api/admin/device-operations` 提交 `install/update/rollback/refresh/test`、引擎 ID、确切版本、设备列表与并发数；`GET /api/admin/device-operations` 分页查询，`GET /api/admin/device-operations/{id}` 查看逐台状态，`POST /api/admin/device-operations/{id}/retry-failed` 仅重试失败或过期设备。命令在控制 WSS 上用 Gateway 密钥签名并绑定设备、动作、参数、幂等键和到期时间；PC 在执行前持久化收据，重复命令返回已有结果。安装/更新/回退仍走本机版本化运行时管理器的官方包目录和互斥逻辑，普通受管本地 API 的引擎管理动作由签名策略门禁拒绝。长时间安装的断线恢复与真实受管包验收仍待完成。

阶段 4C 的设备从标准化用量生成稳定 `usage_event_id`，先写本机 `usage-outbox.db`，控制 WSS 每批最多上传 100 条；Gateway 事务内写入幂等收据和账本，提交后才回复 `usage_ack`。断线或暂时失败保留原批次重发，重复 ID 不二次计量，非法事件进入本机拒收隔离。超级管理员可用 `GET /api/admin/usage` 按设备、用户、项目、供应商、模型和时间范围查询总量；响应含 `unmetered_count`，缺失用量不会显示为零。任务执行/审核、助手会话、协调器、提示词优化和提交信息生成已有用量入口；无 Token 回报的调用记为未完成计量。审计管理员可按组织、部门或设备组查询明细与汇总，作用域包含用户/原始发起人或显式设备归属；范围查询保留原始事件作为依据。账单导入/对账只向超级管理员开放；供应商自动拉账不在 V1 范围。用量和审计页可导出当前已授权的一页 CSV，空值保持未知，不额外读取全局账本。

测试：`uv run --project apps/gateway --group dev pytest apps/gateway/tests packages/gateway-protocol/tests`；协议模型变更后运行 `uv run --project apps/gateway python packages/gateway-protocol/scripts/schema.py` 并提交 `schema.json`。门户在 `apps/gateway-web` 运行 `yarn test && yarn build`。

管理请求失败审计由 Gateway 统一记录认证用户、路由模板、方法与状态，不记录正文、查询或路径参数；持久化失败保留脱敏日志收据。项目任务创建、复制、归档、恢复与删除的审计同写操作事务提交；远程请求拒绝或失败归属可信票据绑定的项目。模型调用与报表等后续批次的验收仍按剩余计划推进。

账本保留与归档：V1 默认不自动删除用量、账单、审计或幂等收据。日聚合队列处理完成后仅移除已处理队列项，原始账本仍保留，支持重建聚合和范围查询。归档使用一致性数据库备份并同时保存签名/加密密钥、配置和 Skills 文件；验明恢复可查询且可重建聚合后再按部署方明确保留期实施离线清理。不得直接以聚合完成为由删除明细或幂等收据。

### 平台分享的任务详情复用

`/share/{token}` 由 Gateway 提供原 WorkStep Web 的独立 `gateway-share` 构建；该构建以 `/workspace-assets/` 为资源基址，动态加载的 Markdown/Mermaid 资源也使用同一基址。配置 `WORKSTEP_GATEWAY_WORKSPACE_WEB_DIST` 指向 `apps/web/dist-gateway-share`，缺少构建时返回 503，不回退到重复的任务界面。门户内部导航到分享地址时重新加载这个服务端入口。

实际查看模块仍为 `SharedTaskView → TaskDetailPage`；`gatewayShareApi` 只替换传输，使用 Gateway 访客 Cookie/CSRF，不获取宿主全局 API 或 WebSocket。会话可恢复；没有公开分享 WebSocket 时每两秒串行刷新任务、最近历史和审核，已翻页历史与展开事件保留，撤权立即清除内容。读取包括执行报告、产物、任务限定 Git 历史/差异/目录；目录路径使用 `workspace:` 虚拟前缀，不返回主机绝对路径，隐藏文件、路径穿越及越界符号链接拒绝。

互动分享沿用原聊天、审核确认和交互表单；仅显示已接通的 Git 操作，工作区增删、凭据设置、合并恢复和文件编辑不在当前分享能力中。内部分享票据携带创建者当前授权的供应商范围与五分钟期限，宿主保留 `share:<id>` 访客身份；停用创建者、撤销分享权限或供应商授权会终止请求。整机与项目隧道均重新检查授权；授权等待后再次核对每台设备 32 条流的容量上限，防止并发请求越过限额。


## 常规启动与目录分层

在仓库根目录执行 `./start-gateway.sh 8700 dev`（后端自动重载），或 `./start-gateway.sh 8700 prod`。脚本构建 `gateway-web` 门户与 `web` 分享查看器，首页提供门户；按 Ctrl+C 停止。也可在 `apps/gateway` 执行 `uv run --no-sync uvicorn main:app --host 0.0.0.0 --port 8700`，已构建的前端目录默认从同仓库查找。生产部署仍需按运维文档设置数据目录、稳定 Gateway ID 和外部地址。

`src/gateway/api/` 声明 HTTP/WS 路由；`services/` 执行业务工作单元；`models/` 按领域定义 SQLAlchemy 模型；`app.py` 装配生命周期、路由和门户。数据库表与迁移不因目录调整变化。

所有服务接受 `contracts.py` 的普通输入及异步端口，不依赖 Request、Response、HTTPException 或 ASGI 应用。`api/adapters.py` 统一构造输入，并把服务返回的数据、凭据变更、文件与异步流映射为 HTTP 响应；Cookie 与 WebSocket 框架适配仅属于接口层。业务错误使用 `GatewayError(reason, message)`，身份错误 `IdentityError` 为其子类，`api/errors.py` 保持原状态码与公开错误结构。失败审计由 `api/request_audit.py` 提取安全元数据，`services/request_audit.py` 入库；静态分享资源在 `api/share_viewer.py`。数据库继续使用 AsyncSession，密码计算及同步磁盘操作必须在工作线程执行。边界由 `tests/test_layering.py` 守护，输入、错误、Cookie 和异步流兼容由 `test_api_adapters.py`、`test_identity_errors.py` 及真实账号、分享、远程通道 API 测试验证。

新平台无用户时，门户 `/auth` 显示“设置超级管理员”，首次提交普通注册接口即可初始化平台并获得超管权限；并发注册只有一位超管，其余为普通账号。首位账号创建后默认开放注册，可由超管在平台设置中调整。旧平台保持原有管理员和恢复账号，旧初始化接口保留兼容。非空但未初始化的异常旧库不会自动提升新注册者。

## 普通 daemon 的平台设置

桌面和移动端均可打开 WorkStep 设置 → 网关平台，填写地址并选择“保存设置”。网关地址支持 HTTPS 和本机回环 HTTP；仅保存地址不会认证或开启网关模式，主动勾选“开启网关模式”并保存后才前往平台认证。关闭模式会取消待认证并断开网关连接，重启后仍保持关闭。移动浏览器通过现有远程访问密钥校验后可读取和保存配置；受管连接的远程修改要求设备所有者会话，项目及分享会话不能修改主机网关。

服务读取平台公钥并固定指纹，发起 PKCE 登录；认证回到发起请求的浏览器入口下的固定 `/api/gateway-platform/callback` 路径，支持手机访问的 HTTP/LAN 和 HTTPS 地址，并校验回跳入口、状态码、验证码、安装身份和签名。首次认证的电脑可能待审批，管理员批准后重新认证；批准后连接现有控制/数据隧道。认证在平台页面完成，daemon 不收集平台账号密码。普通桌面会在返回窗口时刷新认证结果并重载工作台；待审批设备可在管理员批准后重新认证。开发时 Vite 代理保留浏览器 Host，保证回跳与 Cookie 同源检查一致。

常规安装无需特殊受管包。地址和公钥指纹存入 `~/.workstep/config.json` 的 `gateway_platform`，设备私钥在 `gateway-identities/` 的 0600 文件中；未批准时只保存配置，不启用受管授权。重启后重新认证，不持久化浏览器会话或授权票据。原签名受管包仍保持地址固定。

### 选择组织与查看同步进度

在管理后台 → 系统设置 → 平台设置 → 组织同步与扫码登录，配置钉钉或企业微信应用后点击“同步组织”。平台只读取部门列表供勾选，未勾选时不能启动同步；部门的子部门须单独勾选，也可搜索后“勾选搜索结果”。点击“同步所选组织”后显示后台阶段、已读取部门数、当前部门及完成后的组织/用户数量。收起或刷新页面不取消任务，重新打开同一应用可恢复进度；重启服务会把未完成任务标记为中断，需重新启动。失败不会自动扩大同步范围，未选的已有组织与成员保留。后续周期与回调同步沿用最近一次成功的勾选范围；新旧应用尚未选择范围时均不会自动全量导入。

### 用户与成员批量管理

用户管理以显示名识别人；「登录用户名」仅显示具有密码登录能力的真实用户名，组织账号显示扫码登录，内部 ext 标识保留用于身份关联。勾选当前页用户后可批量批准待审核账号、启用已停用账号或停用账号；混合不适用状态时对应按钮禁用，切换搜索/分页/用户组会清空选择。停用前须密码验证，成功后撤销所选用户登录会话，恢复管理员受保护，不能停用最后一位活动超管。

用户组管理左侧选择用户组，右侧管理成员与项目关联。查找用户后逐项勾选或全选当前结果，选择角色再批量添加；已加入的用户不可重复勾选。现有手工成员可批量调整角色或移除，移除仅撤销组成员身份，保留账号；组织同步成员显示只读说明，须在企业通讯录调整后同步。每批最多 100 个账号，批量接口在同一数据库事务内验证所有对象后提交，有对象不存在、越权或只读冲突时整批不变。项目关联以表格显示，提供关联、取消关联与确认交互，仍只授予 Skill 策略关系。

### 仅使用企业扫码登录

在「平台设置 → 组织同步与扫码登录」配置钉钉或企业微信应用并勾选「启用扫码登录」，再在「注册与身份 → 修改登录方式」取消「启用账号密码登录」并验证管理员密码保存。关闭后，普通登录、工作台和桌面端认证均不展示账号密码表单，自主注册关闭；服务层同步拒绝密码登录和注册，现有账号、登录会话及原注册策略保留。恢复账号密码登录后沿用原注册策略。登录入口只显示平台图标与名称，公开接口不返回企业编号。关闭前至少需要一个配置好密钥并启用的扫码应用；扫码独占时不能停用最后一个入口。启用前应确保需要管理后台的用户已关联企业身份并拥有对应权限。

### 用户、用户组删除与统一工作台

用户管理支持单项、勾选批量删除；状态筛选选择“已删除”可恢复。删除立即使账号和已有会话失效，恢复后先处于停用状态，核对授权后再启用。恢复管理员、当前操作账号不能删除，最后一个有效超管也受保护。历史记录和登录用户名保留，不释放用户名。用户组管理支持当前组或勾选组删除、已删除用户组批量恢复；不删除组内用户，不连带删除下级组，历史成员和关联保留。组删除后项目授权、组能力和 Skill 下发失效，恢复会重新启用这些关联（同步组成员按最新目录重新核对）。这些操作均要求超管或对应用户管理范围、CSRF 和密码验证，并保留审计。

门户首页统一为“我的 WorkStep”：左侧设备选择，右侧项目搜索、列表与打开入口。打开设备进入实际 WorkStep 任务和工作流页面，打开项目复用原项目票据。未获分配设备进入原安装 WorkStep 引导，设备上线后自动返回。未登录仍遵循平台配置的密码／扫码登录方式。移除门户用户组 Skills 菜单，后台相关管理功能保留。

网关启动脚本的开发和生产模式均默认监听 `0.0.0.0`（所有 IPv4 网卡），默认端口 `8700`。监听地址与 `WORKSTEP_GATEWAY_PUBLIC_ORIGIN` 是不同配置：前者用于绑定网卡，后者用于生成登录回调及设备入口，不能将 `0.0.0.0` 作为公开访问地址。

## 后台保存平台地址

超管在「管理后台 → 系统设置 → 平台设置 → 修改平台地址」填写完整域名地址并验证管理员密码保存。支持 HTTPS 域名与本地/内网 HTTP 地址，不含路径和查询参数；域名解析、TLS 和反向代理需在部署层完成。地址保存到 `platform_settings.public_origin`，立即用于设备与分享链接；启动时优先恢复数据库中的值，环境变量只提供未保存时的初始默认值，无需改 `.env` 或重新打包。安装页从安装目录接口读取此地址，并提供「复制地址」给客户端远程访问设置使用。
