# WorkStep 平台模式实施计划

> 状态：实施中。阶段 0、1 已交付，后续阶段已分批实现但尚未全部验收；当前进度与验收边界以 [逐阶段开发计划](./platform-gateway-development.md) 为准。2026-10-03 自主账号注册已通过自动化功能验收，企业微信／钉钉真实跳转按用户要求暂不验证。

## 2026-10-03 接入方式修订

本节替代下文“必须用定制包接入”及“首次初始化必须建立恢复账号”的旧规则。常规 WorkStep 安装在 daemon 设置中填写网关平台地址，跳转平台页面认证；支持 HTTPS 和本机回环 HTTP，不需要特殊桌面包。认证使用现有 PKCE、设备审批和控制连接，平台公钥首次固定；既有签名定制包保留兼容。

Gateway 首次启动无用户时进入“设置超级管理员”页面，共用正常注册接口。首位注册者在同一事务中初始化为超管，后续注册按平台策略处理；旧平台的管理员及恢复身份不变。Gateway 后端采用 API、服务、模型分层，根目录启动脚本构建并提供门户首页，后台采用左侧菜单及右侧表格。

## 1. 目标

在保留现有本地优先版本的基础上，增加由 daemon 设置接入的“受管平台模式”。平台模式由独立网关提供自有用户注册与登录、可选企业身份登录、客户端认证、设备连接与整机授权、平台远程项目访问授权、能力策略和操作审计；每台 WorkStep PC 继续运行自己的 Web、daemon 和每项目独立 SQLite 数据库。

平台网关总体结构图：

- [平台网关模式架构图](./platform-gateway-architecture.html)
- [Gateway 注册、组织、用户与设备接入交互原型](./gateway-prototype.html)
- [逐阶段开发计划与验收门](./platform-gateway-development.md)

本计划的核心目标：

- 通用客户端可在 daemon 设置中配置网关平台地址并前往平台认证；未配置时保持本地模式。原网关定制包的签名固定配置保留兼容。
- Gateway 拥有独立、权威的用户体系，支持开放注册、管理员创建和 Gateway 用户名密码登录。
- 钉钉或企业微信是可选的快捷注册/登录身份源；首次登录可按策略创建或关联 Gateway 用户，但第三方账号不是平台用户主表。
- 网关只提供统一的受管客户端安装包，不为每个用户生成专属下载链接或把用户身份写入安装包。
- 受管电脑由 daemon 内的 `GatewayClientService` 主动建立 WebSocket 长连接；Gateway 完成登录、设备登记和权限下发后，用户在本机通过 loopback 直接使用 Web 与 daemon，不让日常界面流量绕行网关。
- 网关能展示在线/离线 PC、PC 分配用户和最近连接状态。
- 网关集中管理可用的 LLM 供应商、模型、价格和分配策略，并通过常驻控制 WSS 把授权配置下发到各 PC。
- 只有用户从网关门户远程打开某台 PC、获授权远程项目或平台公开分享时，界面 HTTP/WebSocket 才经过网关；模型请求始终由执行任务的 PC 直接调用供应商，不经过 Gateway。
- Gateway 关系数据库后端可配置；第一版默认使用 SQLite，后续需要多实例或更高统计写入量时可切换 PostgreSQL。
- 本机项目沿用当前 WorkStep 的目录选择、创建和打开方式，Gateway 不改变或接管本机项目目录规则。
- 管理员可以把其他 PC 上明确发布的平台远程项目直接分配给用户或用户组，并分别授予只读或可编辑访问；项目授权不要求先分配整台 PC。
- 用户能否在项目内创建任务由 Gateway 下发的 `task.create` 能力控制，本机 daemon 是最终执行门禁。
- 配置网关并进入平台模式后，项目访问授权和公开任务分享统一由网关创建、鉴权、代理和撤销，不再使用现有远程项目分享串或 daemon 直出公开链接。
- 本地模式和平台模式下，每一条新消息都必须记录用户名或明确的系统身份。
- 任务启动、排队、暂停、恢复、停止、取消、审核等关键动作必须持久化记录操作者。
- 网关按用户、PC、项目、供应商和模型汇总 Token 用量与估算成本，并区分 PC 回传计量和供应商账单对账。
- 现有项目级数据库继续位于 `<项目目录>/.workstep/workstep.db`。

## 2. 已确认的产品规则

### 2.1 运行模式

系统存在两种安装状态：

- `local`：现有本地模式，不要求登录，使用系统设置中的本地用户名和设备身份。
- `managed_gateway`：安装包已固定指定网关，必须通过 Gateway 自有账户登录；登录方式可以是本地用户名密码，也可以是已配置的钉钉、企业微信等外部身份，项目列表和项目访问按当前用户的可见项目过滤。

两种模式的连接与分享能力互斥：

- 本地模式保留现有点对点“远程项目”和 daemon 直接公开任务分享，行为与当前版本兼容。
- 一旦配置网关并进入平台模式，前端隐藏或禁用远程项目分享串的生成、导入和设备互访入口。
- 平台模式中的“分享项目”表示分配给平台注册用户；“公开分享任务”表示由网关生成公开链接。
- 平台模式不会把已有远程项目自动导入平台，也不会把本地分享凭据转换为平台权限。
- 网关暂时离线时，分享入口显示平台不可用并允许稍后重试，绝不回退为本机直连分享或暴露 daemon 地址。

受管状态规则：

- 安装并启动受管客户端后，`GatewayClientService` 按包内配置连接指定网关，不需要用户填写网关地址。
- 普通用户不能从系统设置退出受管状态、改写网关地址或切回本地模式。
- 管理员可从网关撤销设备；PC 侧只提供明确的“解除管理/恢复出厂”，执行时撤销或清除设备密钥和平台代理状态，并完整写入审计。
- 解绑不删除项目文件；已经执行的任务继续使用启动时持久化的发起人身份，完成后结果留在本机，重新受管前不能从原网关访问。
- 网关地址迁移使用旧网关签发的迁移票据或重新安装另一网关的受管包，不能把地址作为普通文本配置修改。
- 进入受管状态时，停止接受新的远程项目分享、导入和点对点连接；已有长期连接以 `mode_changed` 关闭，已经进入本机业务服务的单次请求允许完成。
- 平台模式下，PC 后端对外拒绝 `/api/remote-project` 连接类操作、本机 `/api/task-share` 创建或撤销以及 `/api/task-share/public/...` 公开访问，不能只依赖前端隐藏入口；网关使用独立平台分享 API 和内部分享票据。
- 设备撤销或解绑时，该设备上的平台公开分享立即暂停；已有本地远程项目登记和本地分享记录不转换为平台数据。

#### 2.1.1 两套用户入口

普通用户登录 Gateway 后有两套入口，二者使用同一 Gateway 身份和同一台 PC 的 WorkStep Web 功能，但数据链路不同：

| 入口 | 使用场景 | 页面链路 |
|---|---|---|
| 本机工作台 | 用户坐在安装 WorkStep 的 PC 前，直接打开 Desktop | `Desktop WebView → 127.0.0.1 daemon`；Gateway 只负责登录、会话兑换和权限下发 |
| Gateway 远程工作台 | 用户在外部电脑、平板或手机浏览器登录 Gateway，打开获整机授权的 PC 或获授权项目 | `浏览器 → Gateway → 按需数据 WSS → daemon`；PC 的控制 WSS 保持常驻，Gateway 通过独立数据 WSS 代理 HTTP、WebSocket、上传和下载 |

Gateway 门户的“打开 PC”进入远程工作台，不是截图、视频流、鼠标键盘级桌面控制，而是通过隧道加载并操作该 PC 正在提供的 WorkStep Web 页面。因此项目、任务、聊天、流程画布和实时事件沿用现有 Web/API 语义；不代理其他桌面应用，也不能访问 WorkStep 之外的 PC 桌面。

远程入口依赖目标 PC 的 daemon 和 `GatewayClientService` 在线，不依赖 Electron 窗口处于前台。客户端最小化或关闭到托盘时可以继续远程访问；用户明确“完全退出 WorkStep”并停止 daemon 后，Gateway 将该 PC 标记为离线并拒绝新代理会话。

远程工作台必须增加远程上下文提示条，持续显示 PC 名称、在线状态、当前用户和“返回我的 PC”。浏览器刷新、路由跳转及 WebSocket 重连都必须保持绑定同一 `device_id`，不能退回 Gateway 本机或串到其他 PC。

桌面原生能力需要单独降级：打开本机 Finder/Explorer、原生目录选择器、唤起本机终端或依赖 Electron IPC 的操作，在远程页面中禁用或改成受约束的服务器端文件浏览与下载。移动端复用现有 Web 的响应式界面；第一版不做远程桌面画面缩放或触控鼠标模拟。

### 2.2 Gateway 数据目录与本机项目

Gateway 数据目录用于保存安装包、Skill 包、临时文件和本地缓存，不再决定关系数据库位置：

```text
<Gateway 数据目录>/
├── releases/
├── skill-packages/
└── cache/
```

第一版默认使用 SQLite，例如 `<Gateway 数据目录>/workstep_platform.db`。Gateway 通过服务端 `database_url` 保留 PostgreSQL 后端选择，但数据库文件名和后端类型都不是平台协议不变量。

员工直接打开 WorkStep 后，项目行为与现有本机版本一致：可以从现有项目列表打开项目，也可以使用当前项目创建/选择目录流程。Gateway 不生成项目路径、不限制到 `projects/{username}`，也不接管项目文件。

本机项目可以明确执行“加入组管理”，只向 Gateway 登记宿主设备 ID、宿主项目 ID、名称和组关系，用于 Skills 策略，但不会变成远程项目。如果进一步执行“发布为平台远程项目”，Gateway 才允许分配给其他用户并代理访问。两种登记都不保存或依赖宿主机绝对路径；取消组管理或取消发布都不删除本机项目。

### 2.3 本地项目、平台远程项目与任务能力

项目来源明确分成：

- `local`：当前 PC 的普通本地项目，目录和数据完全沿用现有 WorkStep。
- `group_managed_local`：仍是本机项目，只登记到某个组用于 Skills 策略，不开放远程访问。
- `gateway_remote`：其他宿主 PC 已发布到 Gateway，并由管理员分配给当前用户或其所属用户组的平台远程项目。

Gateway 项目授权独立于整台 PC 授权。用户没有目标 PC 的完整工作台访问权，也可以通过项目授权访问指定远程项目；此时短期票据必须绑定项目 ID 和访问级别，daemon 只能解析该项目，不能返回宿主 PC 的其他项目。

项目授权支持两类主体和两级访问：

- 主体：单个 `user` 或一个 `group`。组成员变化后按最新有效成员关系计算访问权。
- `read`：查看项目、任务、消息、流程、文件和产物，不允许修改业务数据。
- `edit`：允许编辑项目内容、发送消息和操作已有任务，但不自动获得项目授权管理权。

项目授权、撤销和访问级别调整由管理员执行。项目实际数据仍位于宿主 PC，浏览器通过 Gateway 按需数据 WSS 访问；这套能力与现有点对点远程项目功能保持隔离。

`task.create` 是独立的平台能力，可以按用户全局、用户 × 设备或用户 × 项目范围分配：

- 本地项目：用户具有适用范围的 `task.create` 时，可以使用现有本机接口创建任务。
- 平台远程项目：必须具有直接或组继承的项目 `edit` 权限，并具有该项目或宿主设备范围的 `task.create`；不要求先获得整台 PC 访问权。
- 没有 `task.create` 时仍可按项目现有能力浏览，但创建任务按钮隐藏，daemon 的创建任务服务也必须拒绝。
- 权限通过签名策略快照下发；前端展示不是安全边界，真正校验放在 daemon 的统一任务创建服务入口。

### 2.4 身份与消息署名

无论本地模式还是平台模式，每条新消息都要保存不可为空的作者快照。

统一字段语义：

- `author_id`：作者稳定标识。
- `author_username`：消息创建时的用户名快照。
- `author_name`：消息创建时的显示名称快照。
- `author_type`：`user`、`assistant`、`system` 或 `scheduler`。
- `initiated_by_user_id`：触发系统、助手或定时行为的原始用户。
- `initiated_by_username`：原始发起用户名快照。
- `author_device_id`、`author_device_name`：实际执行或提交操作的设备快照。

记录规则：

| 消息来源 | author | initiated_by |
|---|---|---|
| 本地用户发送 | 系统设置中的本地用户名 | 同一用户 |
| 平台用户发送 | 当前登录用户 | 同一用户 |
| 助手回复 | 助手或引擎身份 | 启动该轮的用户 |
| 系统可见消息 | `system` | 存在原发起人时记录 |
| 定时任务消息 | `scheduler` | 创建或最后启用计划的用户 |
| daemon 恢复执行 | `system` | 原任务运行的发起用户 |

本地模式要求：

- 首次使用仍要求设置本地用户名。
- 本地用户名为空时，不允许发送消息或启动任务。
- 本地用户稳定标识继续使用设备 ID。
- 历史缺失作者的消息显示“历史用户”，不得回填或伪造成当前用户。

覆盖的消息类型：

- 任务执行消息和阶段中途消息。
- 任务协调助手消息。
- AI 流程助手消息。
- 任务创建助手消息。
- 独立聊天会话消息。
- 人工审核消息。
- 系统生成且前端可见的消息。

## 3. 总体架构

### 3.0 平台网关定位

平台模式由一个独立部署的网关把多个 WorkStep PC 汇聚为可登录、可分配和可管控的平台，但 Gateway 是控制面，不是本机日常 UI 的必经数据面。

职责边界：

- 平台网关是控制面：管理注册用户、登录会话、设备、用户与设备分配、供应商配置、在线状态和全局审计。
- 本机使用路径：完成 Gateway 登录和策略同步后，Desktop 直接打开本机 loopback Web；HTTP 与 WebSocket 都在本机闭环。
- 远程使用路径：用户在 Gateway 门户点击另一台或不在身边的 PC 时，网关才代理浏览器 HTTP 请求和 WebSocket 连接到目标 PC。
- WorkStep PC 是执行面：继续运行本机 Web、daemon、引擎、项目数据库和文件系统，网关不接管任务执行。
- PC 主动向网关建立常驻 `wss://` 控制连接，不要求 PC 暴露公网端口，也不依赖网关主动拨入内网 PC。
- 控制连接只承载认证、心跳、策略、配置、设备命令、用量和审计事件；不承载远程页面的大流量 HTTP/WebSocket 数据。
- 用户远程打开整台 PC 或单个项目时，Gateway 与 PC 按需建立一条或多条数据连接，多路复用 HTTP 请求/响应流、文件传输和长生命周期业务 WebSocket；数据连接关闭不影响控制连接。

本机客户端入口：

```text
Desktop 发起 Gateway 登录
  → Gateway 验证用户、设备分配和策略
  → workstep:// 回调 Desktop，PKCE 兑换平台会话与设备作用域授权
  → Desktop 通过一次性本机交换把授权交给 daemon
  → daemon 验证签名并创建 loopback 会话，加载已签名的权限快照
  → Desktop 打开 http://127.0.0.1:<port>
  → 后续本机 HTTP / WebSocket 直接访问 daemon，不经过 Gateway
```

Gateway 门户远程入口：

```text
用户浏览器
  → 登录平台网关并取得平台会话
  → 选择本人获授权的整台 PC，或管理员分配的远程项目
  → 网关签发绑定设备、访问范围和 read/edit 级别的短期票据
  → 网关通过按需数据连接把 HTTP / WebSocket 流转发到目标 PC
  → PC 连接代理验签并把请求交给本机 FastAPI / WebSocket 路由
  → 浏览器获得该 PC 的 WorkStep 前端和实时交互能力
```

平台网关隧道是一套独立的设备接入协议，不依赖、不调用也不扩展现有远程项目运行时。现有 `/api/remote-project`、`/ws/remote-project`、`RemoteAccessService`、`RemoteProjectRegistry` 和 `workstep://remote-project/...` 分享串只服务本地模式；平台隧道拥有独立的节点注册、认证、路由、流复用和审计模型。两者可以复用底层通用工具，但不能共享连接、凭据、项目登记或权限判断。

### 3.0.1 设备身份与用户分配

Gateway 关系数据库新增或扩展以下关系：

- `devices`：设备 ID、设备名称、公钥或凭据摘要、版本、能力、状态、首次/最后连接时间。
- `device_connections`：当前连接 ID、建立时间、心跳时间、断开原因和网关实例；历史记录按保留策略清理。
- `user_devices`：用户与整台 PC 工作台的多对多访问关系、分配人、分配时间和状态。
- `proxy_sessions`：用户点击 PC 后形成的代理会话，记录用户、设备、开始/结束时间、结果和流量摘要，不记录敏感正文。

管理员只能按自己的管理 scope 查看注册 PC、在线状态和分配用户；普通用户只能看到被授予整台工作台访问权的 PC。`user_devices` 只控制完整 PC 工作台入口，项目授权独立生效，不要求存在 `user_devices` 记录，也不能反向扩大为整台 PC 权限。

### 3.0.2 本机身份与可信代理身份

登录兑换成功后，Gateway 除浏览器平台会话外，还签发短期、设备作用域的本机授权，至少绑定用户、设备、`app_instance_id`、策略版本、签发时间和过期时间。Desktop 通过一次性 loopback 交换把它交给 daemon；daemon 验签后创建自己的本机会话。之后本机 API 和 `/ws` 使用 daemon 会话，不为每个请求回查 Gateway。

loopback 监听不能等同于无鉴权。daemon 仍需拒绝没有本机会话的业务请求，限制 Origin，并防止其他本机网页或进程直接借用平台身份。长期 refresh token 和设备私钥保存在 Desktop 主进程或操作系统安全存储中，不能暴露给渲染进程。

远程代理身份必须使用短期签名票据或等价的双方认证机制，不能只注入可由浏览器伪造的 `X-WorkStep-*` 请求头。票据至少绑定：

- 平台用户 ID、用户名和显示名称快照。
- 目标设备 ID。
- 代理会话 ID。
- 签发、过期时间与一次性随机值。
- 必要时绑定请求或 WebSocket 流 ID。

PC 的连接代理验签并确认目标设备后，才把平台身份转换为 `CurrentActor`。此身份继续进入消息作者、任务启动/暂停等审计和后台发起人传播链路。

### 3.0.3 本机策略执行与远程代理路由

Gateway 给每个“用户 × 设备”生成签名权限快照，至少包含：

- `policy_revision`、用户 ID、设备 ID、签发和过期时间。
- 允许使用的平台供应商、模型和默认供应商。
- 是否允许使用或新增本地供应商。
- 是否具有 `task.create`，以及是否允许发布项目、分享任务、安装引擎等预定义受管动作。
- 可访问项目或项目策略版本；大列表可以只携带版本并由控制通道差量同步。

daemon 是本机权限执行点：每个本地 API、WebSocket 订阅、后台启动和引擎调用都从本机会话取得用户，再按已签名权限快照判断。前端隐藏按钮只改善体验，不能代替 daemon 校验。Gateway 通过设备控制连接推送新 revision 和撤销事件；PC 原子替换缓存并回传 `applied_revision`。

离线策略建议采用“基础本地能力继续、平台受控能力限时”：有效快照内允许本地项目浏览和已授权动作；快照过期后禁止启动新的平台供应商调用、修改供应商、分享、安装引擎等受控动作，但已经运行的任务继续完成。具体 TTL 由管理员配置，并在客户端明确显示离线剩余时间，不能无限期缓存已撤销权限。

第一版远程 WorkStep 使用设备子域名承载，避免当前 Web 中 `/api`、`/ws`、图片和下载绝对路径逃离设备作用域：

```text
https://d-<opaque-device-id>.<gateway-domain>/
https://d-<opaque-device-id>.<gateway-domain>/api/...
wss://d-<opaque-device-id>.<gateway-domain>/ws
```

Gateway 负责 wildcard DNS/TLS、设备子域名解析、WebSocket upgrade、Cookie/Location 作用域和流式响应，不解析业务响应正文。整台 PC 会话允许访问该用户被授予的完整工作台；项目会话在同一设备子域名使用项目范围票据，daemon 必须过滤项目列表并拒绝访问票据外的项目。没有 wildcard DNS/TLS 的部署后续才考虑路径前缀方案及完整的 Web runtime base URL 改造。

设备离线、用户被取消分配或账户被禁用时，网关立即拒绝新远程代理流并关闭现有相关流，同时通过控制连接撤销对应本机会话或权限快照。PC 暂时收不到撤销时，最迟在快照过期后停止受控动作；目标 PC 上已经启动的任务继续按持久化发起人身份运行。

### 3.0.4 供应商控制面与下发

网关集中维护供应商配置、模型目录、价格版本和授权范围。PC 连接成功或配置版本变化时，通过常驻控制 WSS 同步“期望配置清单”；PC 原子应用后回传已应用版本、状态和错误。断线重连只同步版本差异，删除或撤销通过 tombstone 明确传播，不能依赖盲目覆盖本机配置。

供应商配置按受管记录下发：

- 元数据：供应商 ID、名称、协议、API 地址、模型白名单、价格版本、启用状态和分发模式，可以下发到获授权 PC。
- 凭据：API Key、访问令牌等可随受管配置下发到获授权 PC，但不得进入日志、审计元数据或项目数据库。

平台模式只使用“受管配置下发”方式：

1. Gateway 保存供应商、模型、API 地址、凭据、适用用户/设备和配置版本。
2. Gateway 按目标设备生成签名配置包，通过设备控制连接下发；是否额外按设备公钥加密属于传输保护，不把密钥视为对本机系统用户保密。
3. PC 验证签名并调用现有供应商配置写入服务，把配置落到现有配置文件或当前已使用的凭据存储位置。
4. daemon 沿用当前本机供应商扫描、加载、测试和调用接口，不增加一套平台代理供应商实现。
5. 模型调用由 PC 直接访问供应商；Gateway 不转发提示词、模型响应或供应商协议流量。

平台模式下，Gateway 下发的供应商标记为 `managed`，在本机界面只读。普通用户不能新增、修改、删除、导入或覆盖受管供应商，也不能通过原有本机 API 绕过；这些限制必须在 daemon 服务层执行，不能只隐藏前端按钮。是否允许额外的本地自有供应商由平台策略控制，第一版默认关闭。

配置更新使用期望版本和原子替换：先写临时配置并校验，再替换正式配置和触发原有供应商 reload；失败时保留上一可用版本并回传错误。撤销使用 tombstone 删除对应受管配置，但不得误删同名本地配置。平台安全边界是“普通用户不能通过 WorkStep 修改或绕过受管配置”，不承诺对拥有本机系统文件权限的用户隐藏已下发密钥。

供应商授权必须同时检查用户和执行设备。仅“已下发到 PC”不代表该 PC 上的所有平台用户都可使用：启动任务时仍需满足当前用户可访问目标 PC、供应商已分配给该用户或设备、目标模型在允许列表内。平台供应商在 PC 端显示为只读配置，并使用稳定命名空间 ID（例如 `platform:<uuid>`），避免与现有本地供应商 ID 冲突。

PC 侧解析优先级固定为：项目显式绑定的平台供应商 → 用户平台默认供应商 → 设备平台默认供应商 → 本地供应商。最后一级只用于本地模式或平台明确允许的本地配置，不能静默绕过平台供应商策略。

### 3.0.5 Token 用量回传与集中统计

每次模型调用生成全局唯一 `usage_event_id` 和 `request_id`，用量记录至少包含：平台用户、原始发起人、执行 PC、项目、任务或会话、供应商、供应商配置版本、模型、输入/输出/缓存 Token、估算成本、计量来源和发生时间。

- 所有平台受管供应商调用都由执行 PC 从标准化 `usage_update` / 最终响应生成用量事件，经设备控制连接回传；Gateway 以 `usage_event_id` 幂等写入并标记 `reported_by_device`。
- 通过网关访问的项目只由真正执行模型调用的项目宿主 PC 回传，浏览器入口 Gateway 不重复上报。
- 供应商账单核对：后续可按供应商的账单或用量 API 做周期性对账；第一版不能把缺失 usage 的调用错误统计为零。
- PC 先持久化本地 usage outbox，再批量上传；Gateway 数据库提交后确认，断线重传按事件 ID 去重。统计上传不得阻塞模型调用完成、设备心跳或远程代理流。

价格按调用发生时的 `pricing_version` 或单价快照计算，历史成本不因管理员后来修改价格而变化。由于 Gateway 不在模型数据路径中，Token 统计默认来自 PC 回传，不等同于供应商最终账单；需要权威核对时使用供应商账单或用量 API 对账。

### 3.0.6 批量 PC 操作与命令编排

网关可以对选中的多台 PC 批量执行受支持的管理动作，例如安装、升级、回退或重新扫描某个引擎。其语义是“网关为每台目标 PC 创建一条有类型的设备命令”，目标 PC 收到命令后调用与本机按钮相同的应用服务。

本机页面、代理页面和网关设备命令必须复用同一个底层服务，例如都调用 `EngineRuntimeManager.start()`；不要让设备命令在 PC 内部再通过 loopback HTTP 请求自己的 FastAPI，也不要复制另一套安装逻辑。HTTP API 是本机点击的传输入口，控制 WSS 命令是另一个入口，二者共享校验、互斥、状态持久化和结果模型。

网关批量作业不是一个阻塞循环：

```text
管理员创建批量作业
  → 网关冻结目标 PC、动作、引擎和版本快照
  → 为每台 PC 创建独立 device_command
  → 按 max_concurrency 分批下发（设为 1 即严格轮流）
  → PC 接收并持久化命令，回传 accepted
  → PC 调用本机应用服务，持续回传 running / progress
  → 网关汇总 succeeded / failed / skipped / offline / expired
```

第一版只允许命令目录中的结构化动作，例如 `engine.install`、`engine.update`、`engine.rollback`、`engine.refresh`、`engine.test` 和 `provider.sync`。不得提供通用 shell、任意 URL 请求或让管理员提交命令行字符串。

命令必须包含管理员身份、目标设备、动作、参数、过期时间、唯一幂等键和签名；PC 验证设备目标、签名、动作白名单、参数 schema、版本兼容性及第三方条款确认后才能接受。

每台 PC 的安装互斥仍由本机运行时管理器负责。网关可以同时操作多台 PC，但同一 PC 已有安装任务时应返回 `busy` 或保留为等待状态，不能启动第二个安装进程。离线设备可以显示为 `offline`，是否排队等待重连由批量作业选项决定；等待命令必须有明确 TTL，过期后不得在数天后突然执行。

### 3.0.7 平台分享

平台模式下，所有新分享都以网关为唯一公开入口：

```text
平台远程项目访问授权
  → 宿主 PC 明确把本机项目发布到 Gateway
  → 管理员把 read/edit 权限授予用户或用户组
  → 网关写入 platform_projects 与 project_access_grants
  → 获授权用户从本机客户端或 Gateway 门户访问远程项目，无需整台 PC 权限

公开任务分享
  → 网关创建 platform_share 并生成 https://<gateway>/share/<token>
  → 访客在网关完成密码或会话校验
  → 网关为本次访问协调按需数据 WSS，把受限请求转发到项目宿主 PC
  → PC 只返回该分享允许的任务、消息、产物和交互能力
```

网关是分享记录、公开 token、密码策略、过期时间、访问会话和撤销状态的权威来源。项目宿主 PC 不生成外部 URL，也不接受公开访客直接访问；PC 只接收网关签发的短期、绑定分享 ID、目标设备、项目、任务和访问模式的内部票据。

公开分享保留当前 `read_only` 与 `interactive` 产品语义，但平台实现不得复用项目数据库中的 `TaskShare` token 或进程内分享会话。项目数据库可以保存业务侧分享状态投影，便于任务页面显示“已分享”，但不能把该投影当作访问凭据。

设备被撤销、解绑或所属网关不可用时，相关平台分享链接停止代理并显示暂不可用或分享已暂停；不能自动降级为 daemon 直连分享。设备重新完成合法绑定后，未过期且未撤销的分享可由管理员恢复。

### 3.0.8 独立应用与 PC 侧最小适配

平台网关不得作为现有 daemon 的一个大模块实现。仓库和部署边界建议为：

```text
apps/
├── gateway/                 # 独立平台服务：控制面、访问入口、隧道服务端
├── gateway-web/             # 独立平台门户和管理中心，可构建后由 gateway 托管
├── daemon/                  # 现有本机业务服务，内含独立 GatewayClientService
├── web/                     # 现有 PC WorkStep 界面，经网关原样代理
└── desktop/                 # 启停 daemon，并处理 workstep://auth/callback

packages/
└── gateway-protocol/        # 版本化消息 schema 与生成代码，不包含业务实现
```

如果第一版不希望增加 `apps/gateway-web`，其源码可以暂放在 `apps/gateway/web/`，但构建产物和运行时仍不能依赖 `apps/daemon`。现有 `apps/web` 继续是 PC 工作界面，不承载平台用户、设备、供应商、批量作业和审计管理页面。

`apps/gateway` 独立实现：

- 平台初始化、数据库后端抽象、迁移、连接池和事务边界。
- 用户、会话、管理员和设备身份。
- 用户-PC 工作台授权，以及已发布远程项目对用户/组的 `read/edit` 授权。
- 常驻设备控制连接、按需数据连接池、HTTP/WebSocket 多路复用、流控和取消。
- 平台分享、供应商配置分发、价格、用量账本和全局审计。
- 结构化设备命令、批量作业、并发、重试、TTL 和幂等状态机。
- 平台 REST/WebSocket API、公开分享入口、管理门户静态资源和可观测性。

daemon 内新增边界清晰的 `services/gateway_client/`，它是 PC 上唯一主动连接网关的模块，负责：

- 读取网关地址和设备配对凭据，建立、保活并重连出站控制 WSS；远程访问时按 Gateway 指令建立按需数据 WSS。
- 上报设备版本、能力、在线状态，以及用户明确发布的项目元数据。
- 把隧道 HTTP/WebSocket 流直接桥接到当前 FastAPI ASGI 应用，不再经过 loopback HTTP。
- 验证网关签名、命令类型、目标设备、协议版本和过期时间。
- 将允许的结构化命令交给与本机 API 共用的应用服务并回传状态。
- 缓冲并幂等回传用量事件、配置应用结果和命令结果。

该模块使用 Python 实现并随 daemon 进程启动，不需要使用 Go。现有 daemon 已经具备异步 lifespan、后台任务关闭、主动 WebSocket 连接和重连模式；第一版增加独立进程只会额外引入本机 IPC、安装守护、版本匹配和故障诊断成本。

`GatewayClientService` 内部继续拆分职责，不能形成一个巨型 service：

- `connection.py`：连接、认证、心跳、重连、协议协商。
- `multiplexer.py`：流 ID、HTTP/WebSocket 帧、流控、取消和背压。
- `asgi_bridge.py`：把代理流转换为 ASGI `scope/receive/send`，复用当前中间件和路由。
- `identity.py`：设备密钥、网关公钥 pin、平台身份票据验证和 `CurrentActor` 注入。
- `commands.py`：结构化命令白名单、参数 schema、幂等与结果回传。
- `config_sync.py`：供应商期望配置和版本回执。
- `usage_outbox.py`：断线期间持久化 usage，重连后幂等补报。

为避免复制业务逻辑，设备命令直接调用与本机 API 共用的应用服务；不得向自己的 HTTP 端口再发请求，也不得执行任意 shell。若某个现有路由仍内联业务逻辑，应先把该逻辑抽成 service，再让 HTTP 路由和设备命令共同调用。

daemon 只增加以下受控接入面：

- `managed_gateway` 状态、网关地址、设备凭据和网关公钥 pin 等只读配置。
- `GatewayClientService` 及 ASGI 代理桥，把已验证的平台身份票据映射为现有 `CurrentActor`。
- 必要的可发布项目清单、结构化管理动作和 usage 事件接口；优先复用已有服务及响应模型。
- 平台模式守卫：拒绝本地点对点远程项目和 daemon 直出公开分享入口。
- 消息作者与任务运行记录接收平台用户名、用户 ID 和原始发起人快照。

daemon 不实现用户注册、平台会话、设备分配、平台项目权限、平台分享 token、供应商密钥托管或批量调度。它只实现受管 PC 必需的连接、代理流终结和本机命令执行。网关也不导入 daemon 的 Peewee 模型，不直接打开任何项目 `.workstep/workstep.db`，不启动引擎和任务。

两端唯一共享物是 `gateway-protocol`：握手、能力、代理流、签名票据、设备命令、配置清单、usage 和错误码的版本化 schema。`gateway` 和 `daemon` 不能互相导入业务模块。后续若性能数据证明必要，可以只把网关服务端的数据平面替换为 Go，不需要重写 daemon 中的 Python 客户端。

### 3.0.9 Gateway 账户、桌面授权回调与网关锁定

Gateway 自有 `users` 是平台账户的权威来源。用户可以通过开放注册创建用户名和密码，也可以由管理员创建或第三方通讯录预先同步导入。开启自注册时，钉钉/企业微信首次登录可按策略即时建号；关闭自注册时，扫码只能匹配已经同步或创建的 Gateway 用户，绝不在登录回调中创建新账户。无论入口如何，最终都落到同一个 Gateway 用户 ID、状态、管理员角色、设备关系、项目权限和审计链中；停用第三方连接器不会删除 Gateway 用户。

受管客户端统一使用 Gateway 的桌面授权入口。登录页同时支持本地用户名密码和已启用的第三方扫码方式：

```text
用户安装网关统一受管包并打开 WorkStep
  → Desktop 生成 state、nonce、PKCE verifier/challenge 和本机 app_instance_id
  → 系统浏览器打开固定网关的桌面登录地址
  → 用户选择 Gateway 用户名密码登录，或使用钉钉/企业微信扫码
  → Gateway 服务端校验 Gateway 账户密码；第三方登录由 Gateway 换取外部身份
  → 查找 Gateway 用户；按策略显式关联、即时创建或进入待审核
  → 网关签发短期、单次使用的 desktop authorization code
  → 浏览器跳转 workstep://auth/callback?code=...&state=...
  → 操作系统唤醒 WorkStep，客户端校验 state 并以 PKCE 换取会话
  → daemon 验证设备作用域授权并建立本机会话
  → Desktop 打开本机 loopback WorkStep 界面
```

用户名、密码、密码哈希和第三方登录凭据只属于 Gateway。daemon 和项目数据库不保存或校验这些密码，也不存在“本地项目账号”。Desktop/daemon 只接收 Gateway 登录成功后签发的一次性授权码、设备作用域授权和用户身份快照。

外部身份返回的姓名只作为显示名称和用户名候选，不能把可变姓名当作账户主键。平台必须同时保存身份源提供的稳定用户标识，并按 `provider + tenant/corp_id + external_subject` 建立唯一约束。用户名处理规则：

- 身份源姓名满足安全字符、长度和唯一性约束时，可直接作为 `username`。
- 中文姓名或包含空格时，保留原值为 `display_name` 与 `external_username`，并生成满足平台账号规则的稳定用户名。
- 同名用户必须使用稳定后缀消歧，不能覆盖已有用户；身份源后来改名只更新展示快照，不改变平台用户名。
- 项目作者和审计同时保存平台用户 ID、稳定用户名和当时的显示名称快照。
- 不按姓名、手机号或邮箱自动合并已有 Gateway 用户。已有用户绑定第三方身份时，必须先登录 Gateway 后确认绑定，或由有权限的管理员明确关联。
- 通过第三方首次创建的用户可以没有 Gateway 密码；用户后续可在已认证会话中为 Gateway 账户设置密码。禁用或解除第三方身份不会自动删除 Gateway 用户。
- 关闭自注册时，通讯录同步必须预先创建 `users` 和 `external_identities`。扫码回调按稳定外部标识命中映射后直接登录；未命中时只提示“账户尚未由组织同步，请联系管理员”，不提供补填用户名或现场注册流程。

网关下载页按操作系统展示该网关统一的受管安装包、版本、校验值和签名。下载 URL 可以带 CDN 鉴权或版本参数，但不得包含用户 ID、登录会话或设备绑定 token。安装包或随包签名配置固定包含：

```text
gateway_id
gateway_origin
gateway_public_key_fingerprint
deployment_channel
最低兼容协议版本
```

同步人员时同时预配 Gateway 账户：优先使用第三方稳定登录名作为 `username` 候选，并按平台字符和唯一性规则规范化；同时写入稳定外部身份映射。用户扫码时实际按 `provider + tenant/corp_id + external_subject` 匹配，再取得对应 Gateway `username`，不能直接拿显示姓名做字符串匹配。

客户端首次启动生成 `app_instance_id` 和设备密钥。扫码成功后的 authorization code 必须绑定 `state`、PKCE challenge、`app_instance_id`、目标网关、用户和短过期时间；数据库只保存摘要，成功兑换后立即失效。自定义协议 URL 只携带一次性 code 和 state，绝不携带 access token、refresh token、第三方令牌或用户敏感资料。

Desktop 必须注册 `workstep://` 自定义协议，并处理重复回调、伪造回调、登录窗口被关闭、code 过期和多开客户端竞争。最终平台会话和设备凭据写入操作系统安全存储；渲染进程不能读取 refresh token 或设备私钥。

受管客户端中的网关地址不提供编辑框。本机保存并锁定安装包签名配置中的 `gateway_id + gateway_origin + 网关公钥指纹`；更换网关必须由原网关管理员发起迁移，或重新安装另一网关签名的受管包，不能通过修改普通设置完成。操作系统管理员仍可能修改本机文件，因此真正的绑定约束依靠包签名、网关公钥 pin、设备密钥和服务端设备登记，而不是只靠隐藏输入框。

受管模式下 Desktop 先完成 Gateway 登录，再打开本机 loopback 工作台。daemon 接受由 Gateway 授权派生的本机会话，并在本机直接处理业务 HTTP/WebSocket；它不接受匿名 loopback 请求，也不要求每个业务请求穿过网关。Gateway 不可用时不能进行新登录或刷新策略，但已有本机会话可按签名权限快照的有效期继续使用基础能力，已运行任务继续执行并在连接恢复后补报状态与用量。

### 3.0.10 第三方身份与组织同步

钉钉、企业微信连接器分成两个可独立启用的能力：`login` 只用于快捷认证和取得姓名，`directory_sync` 才同步企业人员、部门树和隶属关系。第三方通讯录只对其外部组织投影具有权威性；Gateway `users`、账户状态、平台用户名、管理员角色、设备关系和项目权限始终由 Gateway 自己管理。

启用完整通讯录同步时执行：

```text
身份源管理员授权通讯录范围
  → 首次全量同步部门树、人员和人员—部门关系
  → 订阅人员/部门变更事件并幂等增量应用
  → 定时执行全量对账，修复事件丢失或乱序
  → Gateway 在外部组织数据之上叠加平台角色、设备、项目和供应商授权
```

同步边界：

- 外部部门名称、层级、人员姓名、在职状态和外部标识在 Gateway 的组织投影中只读，不提供本地编辑后回写第三方的双向同步。
- Gateway 自己维护的管理员角色、设备关系、远程项目访问授权、供应商授权和平台用户名属于本地 overlay，第三方同步不得覆盖。
- 人员按 `provider + tenant/corp_id + external_subject` 幂等更新；部门按同一身份源作用域内的稳定外部部门 ID 更新。
- 一个用户可以属于多个部门，必须使用独立 membership 关系，不能只在用户表保存单个 `department_id`。
- 部门更名或移动只更新组织投影，不改变用户 ID、平台用户名和历史消息作者。
- 离职或外部账号停用默认禁用该外部身份；是否同步禁用整个 Gateway 用户由连接器策略决定。执行前必须检查用户是否仍有 Gateway 密码或其他有效身份，且不物理删除用户、消息、项目归属和审计记录。
- 部门删除时先标记外部记录失效；本地管理员范围和项目授权进入待处理状态，不能静默转移到根部门。
- 同步接口只能读取管理员在第三方平台授予的通讯录范围；Gateway 页面明确显示“已授权范围”，不能把未授权部门误报为已删除。

同步机制同时包含首次全量、事件增量、周期性全量对账和管理员手动重试。每次同步形成 `sync_run`，保存游标、统计、错误和耗时，不记录第三方 access token 或完整敏感响应正文。

### 3.0.11 超级管理员与分级管理员

Gateway 必须有平台级超级管理员，但不把所有管理能力永久集中到一个账号。第一版建议角色：

| 角色 | 管理范围 | 核心能力 |
|---|---|---|
| `super_admin` | 全平台 | 身份源、管理员、平台设置、全局供应商、设备迁移和恢复 |
| `org_admin` | 指定组织或全组织 | 组织同步、用户审核、角色和部门范围管理 |
| `department_admin` | 指定部门及其子部门 | 范围内用户、设备、项目和供应商分配 |
| `device_admin` | 指定设备组或全设备 | 设备审批、批量引擎操作、客户端升级和配置同步 |
| `audit_admin` | 指定范围只读 | 审计、登录记录、设备连接和 Token 用量查询与导出 |

规则：

- 初始化平台时创建或绑定首位 `super_admin`；正式运行建议至少两名，避免单点锁死。
- 最后一名有效超级管理员不能被降级、禁用或移除。
- 超级管理员变更、身份源密钥修改、设备跨网关迁移和恢复管理员操作要求二次认证并写入审计。
- 分级管理员使用 `scope_type + scope_id` 限制范围；部门管理员默认包含子部门，但可显式关闭递归。
- 角色决定管理页面和管理动作；远程项目访问授权与 `task.create` 等用户能力使用独立记录，不从管理员角色隐式推导。
- 第三方平台中的管理员身份不自动等同于 WorkStep 超级管理员；必须在 Gateway 中明确授予。
- 保留一个不用于日常工作的本地故障恢复管理员，其凭据进入安全存储，使用时产生高优先级审计告警。

### 3.0.12 用户组与项目 Skills 分配

Gateway 支持独立于管理员角色的工作组，例如“安卓组”“后端组”。一个用户可以加入多个组，每个组包含普通成员和一个或多个组长。组长不是平台全局管理员，只能在本组范围内管理成员、关联项目和已授权 Skills。

组可以手工创建，也可以映射钉钉/企业微信部门：

- 手工组的成员由 Gateway 管理。
- 外部部门映射组的基础成员由通讯录同步，组长和平台权限仍是 Gateway 本地 overlay。
- 部门改名不改变组 ID；外部成员离职时按同步策略移出组，但不删除历史任务和审计。

项目加入组只建立 Skills 管理关系，不自动发布为平台远程项目，也不赋予组长查看项目内容的权限。项目需要单独执行“发布到 Gateway”，并由管理员向用户或用户组授予 `read/edit`，才允许远程访问。组长可以给本组关联的项目分配 Skills，但不能借此读取项目消息、文件或任务。

Skills 分发流程：

```text
平台 Skill 管理员发布并审核 Skill 包及固定版本
  → 平台管理员把可用 Skill 授权给安卓组 / 后端组
  → 组长选择本组项目并分配一个或多个 Skill 版本
  → Gateway 生成项目 Skills 期望清单与 revision
  → 宿主 PC 通过设备控制连接接收签名清单和 Skill 包
  → daemon 校验签名、摘要、路径与大小后原子写入项目 .workstep/skills/
  → 更新现有 .workstep-manifest.json 并调用 Skill Center 重新扫描
  → 后续新任务通过现有引擎 Skills 加载链使用；运行中任务不热切换
```

第一版中，普通员工可以在项目 Skills 页面查看来源、版本、同步状态和说明，但不能修改组长下发的受管 Skill。组长只能分配平台已审核且授权给本组的版本；上传、发布或修改 Skill 包需要独立的 `skill_admin` 或超级管理员权限，避免组长向项目任意注入未经审核的指令或代码。

同步与冲突规则：

- 平台 Skill 使用稳定 `skill_id + version + digest`，版本发布后内容不可原地修改。
- Gateway 下发项在项目 manifest 中标记 `source=gateway`、分配组、版本和 revision。
- 不覆盖同名但不属于 Gateway 管理的项目 Skill；出现冲突时保持原文件不变并向 Gateway 回报 `name_conflict`。
- 更新先写临时目录、校验完整内容，再原子替换受管副本；失败保留上一可用版本。
- 撤销只删除带匹配受管标记的副本，不删除员工或项目自己维护的 Skill。
- 同一项目从多个组获得同一 Skill 时，版本必须一致；不一致则由项目显式固定版本，未解决前不应用新版本。
- Skill 包禁止路径穿越和越界符号链接，并限制单文件、总大小和文件数量。
- 分配、升级、撤销、冲突和 PC 应用结果全部写入审计。

### 3.1 数据库分层

Gateway 关系数据库：

```text
第一版默认：SQLite（单 Gateway 实例）
可选后端：PostgreSQL（后续多实例或更高数据量）
```

负责：

- 平台配置。
- 用户与登录会话。
- 设备注册、在线状态和设备连接历史。
- 用户与 PC 的分配关系。
- 浏览器到 PC 的代理会话审计。
- 已发布平台远程项目、所属设备和展示元数据；真实路径的解析权留在宿主 PC。
- 远程项目对用户/组的 `read/edit` 授权与预定义能力授权。
- 供应商元数据、用户/设备授权、配置版本和设备应用状态。
- Token 用量账本与聚合统计。
- 批量 PC 作业、逐设备命令和执行结果。
- 全局操作审计。

项目数据库：

```text
<项目目录>/.workstep/workstep.db
```

继续负责：

- 任务、阶段、消息、助手会话。
- 工作流、审核、产物和项目设置。
- 项目运行时数据。

Gateway 数据层与 daemon 项目数据层完全独立，不复用项目数据库的 Peewee 模型、`db_proxy` 或激活上下文。建议 `apps/gateway` 使用 SQLAlchemy 2.x 异步接口和 Alembic：第一版通过 SQLite 异步驱动运行，同一逻辑模型保留 PostgreSQL 方言与迁移测试。Gateway 的异步路由、WebSocket 和后台任务不得在事件循环中执行同步数据库 I/O。

数据库连接由部署配置提供，例如 `postgresql+asyncpg://...` 或开发用 `sqlite+aiosqlite:///...`。连接串中的用户名、密码和参数不得进入管理页面、普通日志或审计；页面只展示后端类型、脱敏地址、数据库名、连接健康、连接池状态和迁移版本。

第一版明确为单 Gateway 实例，SQLite 承载用户、设备、项目授权、审计和统计数据。达到单实例容量边界后可停机迁移到 PostgreSQL；数据库后端不能在运行中热切换，切换必须经过备份、导出导入和校验。Gateway 多实例及其活跃隧道路由不属于第一版，不能仅因为更换 PostgreSQL 就宣称已支持多实例。

### 3.2 运行时服务

建议新增以下职责边界：

- `ManagedDeviceStateService`：在 PC 侧读取和校验安装包内的受管网关配置，执行撤销、迁移与恢复出厂。
- `GatewayDatabaseManager`：读取服务端数据库配置，管理连接池、迁移、事务、健康检查和优雅关闭；不提供运行时热切换数据库后端。
- `UserAccountService`：Gateway 用户注册、管理员建号、状态变更、用户名不变量和密码生命周期。
- `IdentityProviderService`：钉钉、企业微信身份源配置、扫码回调、外部身份绑定，以及可选的组织同步和即时建号。
- `AuthenticationService`：Gateway 密码校验、外部身份登录、网关会话签发、校验、注销、撤销和故障恢复管理员认证。
- `DesktopAuthorizationService`：生成桌面登录请求，校验 state/nonce/PKCE，兑换 authorization code 并登记设备公钥。
- `DeviceRegistryService`：设备注册、设备凭据轮换、在线状态和能力信息。
- `DeviceAssignmentService`：维护用户与整台 PC 工作台的访问关系，不承载单项目授权。
- `ProjectAccessGrantService`：由管理员维护项目对用户或用户组的 `read/edit` 授权，并在组成员变化后重新计算有效访问。
- `DeviceTunnelManager`：接收 PC 主动建立的控制 WSS，并为远程访问协调按需数据 WSS。
- `GatewayProxyService`：分别校验整台 PC 授权或单项目授权，创建绑定访问范围的短期票据并代理 HTTP/WebSocket。
- `ProviderControlService`：维护平台供应商、授权范围、模型与价格版本，生成设备期望配置清单。
- `ProviderConfigBundleService`：生成签名的受管供应商配置包并跟踪版本与撤销；按设备公钥加密仅作为可选传输保护。
- `ProviderSyncService`：通过控制 WSS 同步配置版本、接收应用回执并处理撤销。
- `GroupService`：维护手工组、部门映射组、成员、组长和组项目范围。
- `SkillCatalogService`：保存平台 Skill 包、不可变版本、摘要、审核状态和组授权。
- `ProjectSkillPolicyService`：计算项目 Skills 期望清单、版本冲突和 revision。
- `ManagedSkillSyncService`：在 PC 侧安全落盘 Gateway Skill，并复用现有 `skill_center` 重新扫描和引擎加载链。
- `UsageLedgerService`：幂等接收模型用量、保存单价快照并生成用户/设备/项目维度统计。
- `DeviceOperationService`：创建批量作业、限制跨设备并发、处理离线策略并汇总结果。
- `DeviceCommandExecutor`：在 PC 上验证和持久化结构化命令，并调用与本机 API 相同的应用服务。
- `CurrentActorService`：统一生成本地或平台操作者快照。
- `PlatformProjectRegistry`：维护项目所属设备、稳定项目 ID、发布状态和访问授权关系。
- `GatewayRemoteProjectResolver`：解析 Gateway 分配的远程项目、宿主设备和访问票据；不接管本机项目目录。
- `AuditService`：追加写入关键操作记录。
- `MessageIdentityService`：为所有消息生成完整作者和发起人字段。

不能让各助手、任务路由、文件路由分别拼装身份字段；必须统一从身份服务取得快照。

### 3.3 网关与受管设备状态

网关服务状态：

- `initializing`：初始化平台数据库和身份源。
- `ready`：可以登录、绑定和代理设备。
- `degraded`：部分身份源、存储或隧道组件异常。
- `unavailable`：不能安全签发会话或代理请求。

PC 受管状态：

- `local`：未受管的标准本地客户端。
- `authenticating`：已启动网关扫码登录，等待自定义协议回调或授权码兑换。
- `managed_connected`：已绑定且 agent 当前连接网关。
- `managed_offline`：已绑定但网关或网络不可达；不能新登录或刷新策略，已有本机会话按缓存权限的有效期继续使用允许的本地能力。
- `revoked`：网关已撤销设备，等待清除本机平台代理状态。
- `migrating`：正在使用管理员签发的迁移票据更换所属网关。

状态写入必须原子化。登录回调或迁移失败时不得留下半写入会话，也不得同时保留两个有效网关身份；daemon 中已经开始的任务不因连接状态变化而中断。

## 4. Gateway 关系数据库模型

### 4.1 `platform_settings`

- `key`，唯一。
- `value_json`。
- `updated_by_user_id`，可空。
- `updated_at`。

数据库连接、密钥引用和 Gateway 数据目录等启动配置保存在网关服务端部署配置中；平台内部业务设置保存在关系数据库。PC 只保存网关地址、设备凭据和策略快照，不直接连接 Gateway 数据库，也不增加平台专用项目根目录。

### 4.2 `users`

- `id`。
- `username`，唯一、不可修改。
- `display_name`。
- `password_hash`，可空；仅外部身份登录的用户可以暂未设置 Gateway 密码。
- `registration_source`：`local`、`admin_created`、`dingtalk`、`wecom`、`directory_sync`。
- `must_change_password`、`password_changed_at`。
- `status`：`pending`、`active`、`disabled`。
- `created_at`、`updated_at`、`last_login_at`。
- `created_by_user_id`，首位管理员可空。

用户名建议仅允许 ASCII 字母、数字、下划线和短横线，统一小写或执行不区分大小写的唯一约束，形成稳定的平台标识。管理员角色统一由 `admin_assignments` 表表达，不在 `users` 上再维护第二套容易漂移的 `role` 字段。

### 4.3 `auth_sessions`

- `id`。
- `user_id`。
- `token_hash`，不保存明文令牌。
- `created_at`、`expires_at`、`revoked_at`。
- `last_seen_at`。
- `device_id`、`device_name`。

### 4.4 `platform_projects`

- `id`，Gateway 平台项目 ID。
- `name`。
- `device_id`，项目所在的宿主 WorkStep PC。
- `host_project_id`，目标 PC 内的稳定项目 ID；与 `device_id` 组成唯一约束。字段命名不得使用 `remote_project_id`，避免与本地点对点远程项目混淆。
- `access_mode`：`policy_only`、`remote_published`。前者只用于组 Skills 策略，不允许远程打开。
- `published_by_user_id`、`published_at`。
- `created_by_user_id`。
- `created_at`、`updated_at`。
- `status`：`active`、`unavailable`、`unpublished`。

### 4.5 `project_access_grants`

- `id`、`project_id`。
- `subject_type`：`user`、`group`。
- `subject_id`：用户 ID 或用户组 ID。
- `access_level`：`read`、`edit`。
- `assigned_by_user_id`、`created_at`、`revoked_at`。
- `(project_id, subject_type, subject_id)` 唯一。

该表只表达 `remote_published` 项目的访问授权，由管理员维护。用户的有效权限取直接授权与当前有效组授权的并集，`edit` 高于 `read`；组成员被移除或授权被撤销后，Gateway 立即关闭对应项目代理会话。`policy_only` 项目禁止写入访问授权。整台 PC 的 `user_devices` 与此表相互独立。

### 4.5.1 `capability_assignments`

- `id`、`user_id`。
- `capability`，第一版至少包含 `task.create`。
- `scope_type`：`global`、`device`、`project`。
- `scope_id`，全局范围可空。
- `effect`：`allow`、`deny`，显式拒绝优先。
- `assigned_by_user_id`、`created_at`、`revoked_at`。

Gateway 将有效能力编译进用户 × 设备的签名策略快照。daemon 不直接查询平台数据库，而是依据当前快照在共享业务服务入口执行校验。

### 4.6 `audit_events`

- `id`，建议 UUIDv7。
- `mode`：`local`、`platform`。
- `actor_type`。
- `user_id`、`username`、`display_name`。
- `initiated_by_user_id`、`initiated_by_username`。
- `device_id`、`device_name`。
- `action`。
- `project_id`、`task_id`、`step_key`、`run_id`、`message_id`。
- `result`：`success`、`failure`、`denied`。
- `metadata_json`，只保存经过白名单过滤的精简元数据。
- `request_id`。
- `created_at`。

审计记录只追加，不提供普通编辑和删除接口。不得记录密码、会话令牌、模型密钥或完整敏感消息正文。

审计是“谁在什么时候对什么对象执行了什么操作”的结构化操作记录，不是消息正文、远程代理协议或屏幕录像。Gateway 直接记录登录、用户/组变化、项目授权、供应商下发、批量命令和分享操作；PC 记录任务启动、暂停、恢复、停止等本机业务动作。受管模式下 PC 先写本地 audit outbox，再通过控制 WSS 以 `audit_event_id` 幂等上传 Gateway；断网不丢记录，也不阻塞任务操作。本地模式没有 Gateway 时，同一结构写入本机持久化存储。

### 4.7 `platform_providers`

- `id`，稳定平台供应商 ID。
- `name`、`type`、`protocols_json`、`base_urls_json`。
- `management_mode`：第一版固定为 `managed_device`。
- `model_policy_json`、`pricing_version`。
- `enabled`、`revision`。
- `created_by_user_id`、`created_at`、`updated_at`。

该表不保存可直接返回客户端的明文 API Key。凭据使用系统凭据库、外部 Secret Manager 或独立加密记录，并以 `secret_ref` 关联。

### 4.8 `provider_assignments`

- `provider_id`。
- `scope_type`：`user`、`device`。
- `scope_id`。
- `enabled`、`is_default`、`priority`。
- `assigned_by_user_id`、`created_at`、`updated_at`。
- `(provider_id, scope_type, scope_id)` 唯一。

第一版供应商授权仍按用户和设备计算；用户组先用于成员与项目 Skills 管理，不自动扩大供应商权限。一次调用必须同时通过用户和执行设备的有效策略计算，不能仅凭 PC 已收到配置就授权使用。

### 4.9 `device_provider_state`

- `device_id`、`provider_id`。
- `desired_revision`、`applied_revision`。
- `status`：`pending`、`applied`、`failed`、`revoked`。
- `last_error_code`、`last_error_summary`。
- `last_sync_at`、`acknowledged_at`。
- `(device_id, provider_id)` 唯一。

错误摘要必须脱敏。管理员通过该表判断某台 PC 是否真正应用配置，而不是只看网关是否发送成功。

### 4.10 `usage_events`

- `id` / `usage_event_id`，全局唯一，用于幂等去重。
- `request_id`、`source`：`reported_by_device`、`provider_reconciled`。
- `user_id`、`initiated_by_user_id`、`device_id`、`project_id`。
- `task_id`、`run_id`、`message_id`、`session_id`。
- `provider_id`、`provider_revision`、`model`。
- `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`total_tokens`。
- `currency`、`unit_price_snapshot_json`、`estimated_cost`。
- `occurred_at`、`received_at`。

明细账本追加写入，按日/用户/设备/项目/供应商生成可重建的聚合表或缓存。修改价格只影响后续事件，不重写历史明细。

#### 4.10.1 Token 统计上传与数据库写入

PC 不逐条同步等待 Gateway 写库。每次模型调用完成后先把用量事件写入本机持久化 outbox，再按事件数、字节数或时间窗口组成批次上传。每批包含 `batch_id`，每条事件包含稳定的 `usage_event_id`；Gateway 只有在数据库事务提交成功后才返回 ACK，PC 收到 ACK 后才能清理对应 outbox。超时或断线按指数退避和随机抖动重试，重传不得重复计费。

第一版在 SQLite 中使用批量参数化 `INSERT` 和短事务。写入事务执行以下步骤：

1. 校验设备身份、事件 schema、数值范围、时间漂移和批次大小。
2. 向 `usage_event_receipts` 写入全局唯一 `usage_event_id`，已存在的事件视为幂等成功。
3. 只把新收据对应的事件写入追加式 `usage_events` 明细表。
4. 事务提交后返回已接受、重复和拒绝的事件 ID；失败时整批保持可重试。

高频查询维度使用普通列和组合索引；`metadata_json` 只保存有大小上限的非敏感扩展字段，用户、设备、项目、供应商、模型、Token 和时间不得只藏在 JSON 中。切换到 PostgreSQL 后，可以在不改变上传协议的前提下增加按月分区或批量导入优化。

另建可重建的 `usage_daily_rollups`，按日期、用户、设备、项目、供应商和模型汇总 Token 与估算成本。聚合 worker 使用持久化水位增量计算，并允许从明细账本重建；统计页优先读取聚合表，明细追踪再查询 `usage_events`。供应商对账结果作为独立来源写入，不覆盖 PC 原始上报。

统计写入必须与登录、授权、设备心跳和代理控制请求隔离：至少使用独立连接池或并发额度和有界队列，设置批次上限、语句超时与背压；过载时返回可重试状态和 `retry_after`，不得无限堆积内存或耗尽控制面连接池。生产环境配置明细保留期、分区预创建与归档策略，删除明细前必须确保所需聚合和审计留存完整。

### 4.11 `device_operation_batches`

- `id`、`action`、`parameters_json`。
- `created_by_user_id`、`created_at`。
- `max_concurrency`、`offline_policy`、`expires_at`。
- `target_count`、`status`。

创建后目标设备和参数保存为快照，后续设备筛选结果变化不能悄悄改变已创建作业。

### 4.12 `device_commands`

- `id`、`batch_id`、`device_id`。
- `action`、`parameters_json`、`idempotency_key`，其中幂等键唯一。
- `status`：`queued`、`dispatched`、`accepted`、`running`、`succeeded`、`failed`、`skipped`、`cancelled`、`expired`。
- `progress_json`、`result_summary`、`error_code`。
- `attempt_count`、`dispatched_at`、`accepted_at`、`finished_at`、`expires_at`。

PC 必须持久化最近处理过的命令 ID 与最终结果。网关因断线重发同一命令时，PC 返回原状态或结果，不重复安装。

### 4.13 `platform_shares`

- `id`、`token_hash`，数据库不保存可直接使用的明文 token。
- `device_id`、`project_id`、`task_id`。
- `mode`：`read_only`、`interactive`。
- `title`、`password_hash`，密码可空。
- `created_by_user_id`、`created_at`、`expires_at`、`revoked_at`。
- `status`：`active`、`paused`、`revoked`、`expired`。

公开 URL 只指向网关。创建和撤销必须同步更新项目宿主 PC 的非敏感分享状态投影，但以网关记录为最终权威。

### 4.14 `platform_share_sessions`

- `id`、`share_id`、`session_token_hash`。
- `created_at`、`expires_at`、`revoked_at`、`last_seen_at`。
- `client_fingerprint_hash`，可选。

分享会话只允许访问分享记录绑定的设备、项目、任务和模式；不得升级为平台登录会话，也不得枚举同一 PC 的其他项目。

### 4.15 `identity_providers` 与 `external_identities`

`identity_providers`：

- `id`、`type`：`dingtalk`、`wecom`，后续可扩展 OIDC。
- `tenant_id` 或 `corp_id`、应用标识、启用状态和显示顺序。
- secret reference、回调地址、配置版本和最近验证状态；客户端密钥不以明文进入普通配置响应。
- `login_enabled`、`directory_sync_enabled`，两种能力可独立开启。
- `jit_provisioning_enabled`、允许组织范围和新用户默认状态；仅在自注册开启时允许为 `true`。

`external_identities`：

- `id`、`user_id`、`provider_id`。
- `external_subject`，身份源中的稳定用户标识。
- `external_username`、`display_name` 和组织信息快照。
- `created_at`、`last_login_at`、`last_synced_at`、`disabled_at`。

唯一约束为 `provider_id + external_subject`。不能用姓名、手机号或邮箱单独合并账户；跨身份源绑定必须由已登录用户或管理员明确确认。

### 4.16 `desktop_auth_codes`、`device_bindings` 与 `client_releases`

`desktop_auth_codes` 保存 authorization code 摘要、用户、`app_instance_id`、PKCE challenge、state 摘要、过期时间和使用时间。code 短期且只能成功兑换一次。

`device_bindings` 保存设备、首次绑定用户、当前网关、设备公钥、绑定时间、撤销时间和迁移状态。第一版一个设备在正常状态下只能归属一个 Gateway。

`client_releases` 保存操作系统、架构、版本、下载地址、文件大小、哈希、签名、固定 `gateway_id`、`gateway_origin`、网关公钥 pin、最低协议版本和发布状态。同一网关内所有用户下载同一个受管包，不生成用户专属安装包或链接。

### 4.17 组织、同步与管理员范围

- `external_tenants`：身份源、企业 ID、授权范围、同步状态和 secret reference。
- `external_departments`：外部部门 ID、父部门 ID、名称、排序、状态和同步版本。
- `external_user_departments`：用户、部门、是否主要部门、职位和负责人标记。
- `directory_sync_runs`：全量/增量/对账类型、游标、开始结束时间、统计、结果和错误摘要。
- `admin_assignments`：用户、管理员角色、scope 类型、scope ID、是否包含子部门、授予人和撤销时间。

第三方组织表保存只读投影，WorkStep 权限表保存本地 overlay；两类数据不得混在同一 JSON 字段中，以免同步覆盖平台授权。

### 4.18 用户组、项目范围与 Skills

`user_groups`：

- `id`、`name`、`slug`、`description`。
- `source_type`：`manual`、`external_department`。
- `external_department_id`，可空。
- `status`、`created_by_user_id`、`created_at`、`updated_at`。

`group_memberships`：

- `group_id`、`user_id`。
- `role`：`leader`、`member`。
- `source`：`manual`、`directory_sync`。
- `assigned_by_user_id`、`created_at`、`revoked_at`。
- `(group_id, user_id)` 唯一。

`group_projects`：

- `group_id`、`platform_project_id`。
- `purpose`：第一版固定为 `skill_management`。
- `assigned_by_user_id`、`created_at`、`revoked_at`。

该关系只授权组长管理项目的受管 Skills，不自动授予项目内容访问权或远程项目授权管理权。

`skill_packages` 与 `skill_versions`：

- Skill ID、名称、说明、所有者、可见范围和审核状态。
- 不可变版本、内容摘要、签名、包引用、文件数量、总大小和兼容信息。
- 发布者、审核者、发布时间、撤销时间和撤销原因。

`group_skill_catalog`：

- `group_id`、`skill_id`、允许的版本范围或固定版本。
- `granted_by_user_id`、`created_at`、`revoked_at`。

`project_skill_assignments`：

- `platform_project_id`、`skill_id`、`skill_version_id`。
- `source_group_id`、`assigned_by_user_id`。
- `desired_revision`、`status`、`created_at`、`revoked_at`。
- `(platform_project_id, skill_id)` 唯一，保证一个项目最终只有一个有效版本。

`device_project_skill_state`：

- `device_id`、`host_project_id`、`desired_revision`、`applied_revision`。
- `status`：`pending`、`applied`、`conflict`、`failed`、`revoked`。
- `last_error_code`、`last_error_summary`、`acknowledged_at`。

## 5. 登录与注册页面

### 5.1 首位管理员初始化 `/platform/setup`

只在 Gateway 关系数据库没有管理员时开放。

字段和步骤：

- 只读的数据库后端、脱敏连接信息、连接健康和迁移版本；不显示数据库密码。
- 创建首位 Gateway 本地超级管理员：用户名、显示名称、密码和确认密码。
- 配置是否开放注册，以及新注册用户直接启用还是等待审核。
- 钉钉、企业微信或后续 OIDC 身份源作为可选后续步骤，不阻塞平台初始化。

行为：

- 首位管理员创建成功后自动登录并跳转 `/admin`。
- 后续可以为该管理员绑定钉钉或企业微信，但绑定不会替代或删除 Gateway 自有账户。
- 至少保留一个可用的本地超级管理员作为故障恢复入口；其凭据进入安全存储策略并产生高优先级审计。
- 初始化完成后，接口永久拒绝再次创建首位管理员。

### 5.2 注册 `/register`

Gateway 提供独立注册页，字段为用户名、显示名称、密码和确认密码。用户名创建后不可修改，但不参与本机项目目录生成。页面同时可以展示“使用钉钉注册”和“使用企业微信注册”，但二者最终仍创建 Gateway 用户。

状态：

- `registration_mode=open`：本地注册后创建 `active` 用户并登录。
- `registration_mode=open_with_approval`：本地注册后建立 `pending` 用户并展示等待审核，不签发业务会话。
- `registration_mode=closed`：隐藏普通注册入口，第三方即时建号强制关闭，只允许管理员创建或通讯录预同步的用户登录。
- `jit_provisioning_enabled` 控制第三方首次登录能否创建 Gateway 用户，但配置校验必须保证 `registration_mode=closed` 时它为 `false`。
- 用户不在允许企业或组织范围：拒绝登录且不创建本地用户。
- 同名不阻断注册，由网关生成稳定且唯一的平台用户名。
- 密码使用 Argon2id 等自适应哈希；注册、登录和密码重置均限速，错误提示不得泄露用户名是否存在。

### 5.3 登录 `/login`

入口：

- Gateway 用户名与密码。
- 钉钉扫码登录。
- 企业微信扫码登录。
- 未启用的第三方入口不显示；第三方连接器故障不影响 Gateway 用户名密码登录。

状态：

- 自注册关闭时不显示注册链接；扫码用户若已由通讯录同步，则匹配后直接登录，不展示注册步骤。
- 自注册关闭且扫码身份没有预同步映射时拒绝登录，不允许扫码回调绕过管理员的注册策略。
- 扫码过期、取消、企业不匹配和身份源不可用分别给出可恢复提示。
- 待审核账户明确提示等待审核。
- 禁用账户明确提示联系管理员。
- 登录失效时保存原目标路由，成功后返回。
- 登录成功但没有绑定 PC 时进入 `/devices/empty`，展示该网关统一受管安装包；安装后从客户端再次发起扫码登录即可注册当前 PC。
- 已有绑定 PC 时进入 `/devices`；只有一台可用 PC 时可以配置为直接代理进入。
- 管理员扫码或密码登录后仍先得到普通 Gateway 用户会话；默认进入“工作台”，不会因为有管理员角色而强制跳到后台。

第一版不依赖邮件找回密码：已登录用户可以修改密码，管理员可以签发短期一次性重置票据或设置“下次登录必须修改”的临时密码。外部账号恢复仍由身份源处理；管理员不能替用户设置钉钉或企业微信密码。所有登录方式最终签发同一种 Gateway 会话，数据库只保存会话令牌摘要，浏览器使用 `HttpOnly + Secure + SameSite` Cookie 并配合 CSRF 防护。

## 6. 管理页面

管理中心使用独立完整页面布局，不继续堆叠到现有 `Layout` 或系统设置弹框中。

管理员与普通员工使用同一 Gateway 用户和同一登录会话，不建立第二套后台账号。具有任一有效管理授权的用户在门户主导航看到两个一级 Tab：

- `工作台`：我的 PC、我的项目和账号。管理员在这里与普通用户一样，可以打开自己的本机 WorkStep，或通过 Gateway 远程工作台操作自己获分配的 PC。
- `管理后台`：用户、组织、设备、供应商、用量、项目、Skills、审计和平台设置。页面和数据按 `admin_assignments` 的角色与 scope 过滤。

登录后默认落到 `工作台`，用户主动切换到 `管理后台`；从管理后台返回工作台不重新登录、不重新扫码。超级管理员看到全平台管理导航，分级管理员和组长只看到获授权模块和范围。管理身份不会隐式授予某台 PC 或某个项目的日常访问权；管理员要远程打开自己的软件，仍需满足普通设备分配和项目访问规则。

### 6.1 路由

- `/admin`：管理概览。
- `/admin/users`：用户管理。
- `/admin/org`：部门树、成员关系和第三方同步状态。
- `/admin/admins`：超级管理员、分级管理员和管理范围。
- `/admin/identity-providers`：钉钉、企业微信授权及同步策略。
- `/admin/devices`：PC 与连接管理。
- `/admin/providers`：供应商、模型、分配与同步状态管理。
- `/admin/groups`：安卓组、后端组等用户组、组长、成员和项目范围。
- `/admin/skills`：平台 Skills 目录、版本、审核、组授权和设备同步状态。
- `/admin/usage`：Token 用量与成本统计。
- `/admin/shares`：平台公开分享管理。
- `/admin/projects`：项目管理。
- `/admin/audit`：操作记录。
- `/admin/settings`：平台设置。
- `/devices`：普通用户的已分配 PC 列表。
- `https://d-<opaque-device-id>.<gateway-domain>/...`：经网关代理的目标 PC WorkStep 界面；使用不透明设备标识，要求通配符 DNS 与 TLS。

仅具有有效管理授权的用户显示“管理后台”Tab。普通用户直接访问管理路由时跳转工作台并提示无权访问；scope 不匹配的管理员访问其他组织、设备或项目时返回无权访问，不能仅靠导航隐藏。

### 6.2 管理概览

展示：

- 用户数、在线 PC 数、项目数、共享项目数、运行中任务数。
- 待审核用户数量。
- 离线或版本过旧的 PC。
- 已发布但宿主 PC 当前离线的项目。
- 最近关键操作。

概览只提供导航和摘要，不承载复杂编辑。

### 6.3 用户管理

列表字段：

- 用户名、显示名称、角色、状态。
- 拥有项目数、可见项目数。
- 最近登录时间。

筛选：

- 用户名或显示名称。
- 状态。
- 角色。

操作：

- 预先导入或映射企业用户。
- 通过注册审核。
- 启用或禁用。
- 解除或重新绑定外部身份。
- 设置或取消管理员。
- 查看拥有及可见项目。

用户名不可修改。已产生消息或审计记录的用户不物理删除，只允许禁用。

### 6.3.1 部门与组织同步

页面左侧展示第三方部门树，主区域展示当前部门直属成员、子部门、负责人、已授权范围和同步状态。提供：

- 首次全量同步、手动对账和失败重试。
- 最近同步新增、修改、调岗、离职、部门移动和删除统计。
- 同步游标、事件延迟、最近成功时间和错误摘要。
- 外部字段只读标识；管理员只能修改 WorkStep 本地角色和授权 overlay。
- 未授权范围、第三方已删除和同步失败使用不同状态，不能统一显示为空部门。

### 6.3.2 管理员管理

列表展示管理员、角色、管理范围、身份来源、最近管理动作、状态和授予人。超级管理员可以添加、调整和撤销管理员；危险操作使用二次认证和 `ConfirmDialog`。

权限详情使用矩阵展示用户、组织、设备、项目、供应商、用量和审计能力。部门管理员选择一个或多个部门范围，并明确是否包含子部门；设备管理员使用设备组范围，不因同时属于某部门自动扩大权限。

### 6.4 PC 与连接管理

列表字段：

- PC 名称、设备 ID、系统与 WorkStep 版本。
- 在线/离线状态、首次连接、最后心跳和断开原因。
- 已分配用户数量、活跃代理会话数量。
- 本机项目数量摘要和已发布平台远程项目数量。

操作：

- 审批或拒绝新设备注册。
- 多选 PC 后批量安装、升级、回退、重新扫描或测试引擎。
- 修改 PC 展示名称。
- 分配或移除可访问用户。
- 撤销并轮换设备凭据。
- 查看连接历史和当前代理会话。
- 点击“打开 PC”通过网关进入该 PC 的 WorkStep 界面。
- 停用设备；默认不删除目标 PC 上的任何项目文件。
- 查看该 PC 的平台供应商期望版本、已应用版本和最近同步错误。

设备详情页应明确区分“设备在线”与“daemon 健康”。WebSocket 连接存在但本机 WorkStep 无法处理请求时，状态应显示为故障而不是在线可用。

批量操作页按 PC 展示排队、已接收、执行中、成功、失败、离线和过期状态，并允许只重试失败项。创建作业前必须展示目标 PC 数量、引擎、确切版本、预计下载量、并发数和第三方条款；确认后不得因筛选条件变化而增减目标。

### 6.5 供应商管理

列表字段：

- 供应商名称、协议、受管状态和启用状态。
- 可用模型数量、价格版本。
- 已分配用户和 PC 数量。
- 配置已应用、等待同步、失败和离线设备数量。

操作：

- 创建、编辑、停用和轮换供应商凭据。
- 维护模型白名单与价格。
- 按用户或 PC 分配、撤销和设置默认供应商。
- 查看每台 PC 的期望版本、已应用版本和脱敏错误。
- 测试连接命令下发到目标 PC，复用现有本机供应商测试接口，只向 Gateway 回传成功、错误码和脱敏摘要。

普通用户和 PC 端界面展示获授权的供应商名称、模型与可用状态，不单独提供凭据查看入口；拥有本机系统文件权限的用户仍可能读取已落盘配置，因此密钥保密不是这套管控的安全边界。PC 端平台供应商为只读；只有平台策略明确允许时才显示独立的本地供应商分区，第一版默认不允许自行新增或修改。

### 6.6 Token 用量

支持按时间范围、用户、PC、项目、供应商和模型筛选，展示输入、输出、缓存及总 Token 和估算成本。详情能定位到任务、会话、消息或请求 ID，但不展示 Prompt、消息正文、API Key 等敏感内容。

统计页面必须标明计量来源：PC 回传或供应商对账。对于缺失 usage、等待回传或对账差异，展示“未完成计量”或差异状态，不能静默计为零。

### 6.6.1 用户组与 Skills 管理

用户组页面展示组名称、来源、组长、成员数、关联项目数和已授权 Skills 数。平台管理员可以创建组、映射外部部门、指定组长、调整成员和停用组；组长进入同一页面时只看到自己管理的组。

组详情包含：

- 成员：搜索并添加 Gateway 用户；外部部门同步成员显示只读来源。
- 项目：选择本机明确加入组管理的项目；绑定本身不开放远程访问。
- Skills：从平台已审核且授权给该组的目录中选择固定版本，并分配到全部组项目或指定项目。
- 同步状态：按项目和宿主 PC 展示期望 revision、已应用 revision、冲突、失败和离线状态。

平台 Skills 页面提供包详情、版本历史、内容摘要、兼容引擎、发布者、审核状态、获授权组和使用项目。发布新版本后不自动替换旧版本；管理员或组长必须明确升级，支持先选少量项目试运行再批量推广。

项目 Skills 页面继续复用当前 Skill Center UI，并为 Gateway 下发项增加“平台受管”“来源组”“固定版本”和同步状态。普通成员可以查看和在任务中使用，但不能通过现有 `/api/skills/projects/{project_id}` 接口关闭、覆盖或删除受管项；该限制必须进入 `skill_center` 的服务层。

### 6.7 项目管理

列表字段：

- 项目名称。
- 宿主 PC。
- 发布者。
- 已授权用户与用户组数量。
- 当前授权级别摘要（`read/edit`）。
- 宿主连接状态。
- 当前运行状态摘要。

操作：

- 从在线 PC 的可发布项目清单中选择并发布项目。
- 向用户或用户组授予、调整或撤销 `read/edit`。
- 给用户或用户组授予项目范围的 `task.create` 能力；设备范围能力仅用于整台 PC 工作台授权。
- 从 Gateway 门户远程打开项目。
- 取消发布；必须提示“只移除 Gateway 登记和访问授权，不删除宿主 PC 的项目目录或数据”。

### 6.8 操作记录

筛选：

- 时间范围。
- 用户。
- 项目。
- 操作类型。
- 结果。
- 关键字。

列表展示：

- 时间、用户名、动作、项目、目标、结果。

详情展示：

- 操作者、设备、运行模式。
- 原始发起人。
- 项目、任务、阶段和运行标识。
- 精简元数据。

### 6.9 平台公开分享管理

列表展示分享标题、创建者、宿主 PC、项目、任务、模式、访问次数、最后访问时间、过期时间和状态。管理员可以筛选、暂停、恢复和撤销分享，但不能查看分享密码或明文 token。

具有 `share.create` 能力的项目编辑者或管理员可以在任务页面创建、复制和撤销平台分享。分享 URL 始终使用网关地址；目标 PC 离线时分享页显示临时不可用，不泄露 PC 地址或自动切换到 daemon 直连。

### 6.10 平台设置

分区：

- 平台基本信息。
- 注册开关。
- 新用户是否需要管理员审核。
- 会话有效期。
- 钉钉、企业微信身份源和即时建号策略。
- 客户端发布版本、下载源、签名与最低协议版本。
- Gateway 数据目录，以及关系数据库后端、脱敏地址、连接池健康和迁移版本。
- 本机项目是否允许发布到 Gateway，以及默认远程项目授权策略。
- `task.create` 等能力的默认值和离线策略有效期。
- 设备撤销、网关迁移与恢复流程。

数据库连接串只能通过服务端部署配置和受控迁移流程修改，不能在 Web 管理页热切换。撤销设备和网关迁移使用 `ConfirmDialog`，执行期间持续展示旋转状态。

## 7. 用户侧项目页面

### 7.0 我的 PC 与远程入口

`/devices` 以卡片或列表展示当前用户获分配的 PC：

- PC 名称、在线状态、最后在线时间和版本。
- 该 PC 上当前用户可见的项目数量与运行中任务摘要。
- 在线且健康时显示“打开 WorkStep”；离线时按钮禁用并说明最后在线时间。

点击 PC 后进入 `https://d-<opaque-device-id>.<gateway-domain>/...`。该页面不是只读预览，而是由网关代理的完整 WorkStep 界面，支持导航、API、文件上传下载和实时 WebSocket 操作。设备独立子域可以保留现有前端对 `/api`、`/ws` 等根路径的使用，避免把全部资源重写成路径前缀。用户可以在外部电脑、平板或手机浏览器使用该入口，前提是目标 PC 的 WorkStep 与 Gateway 控制 WSS 在线且按需数据 WSS 可建立。页面顶部保留网关级设备提示条，显示当前 PC 名称、连接状态和“返回我的 PC”，避免用户误以为正在操作网关本机。

远程页面不能声称控制整台 PC：它只操作该 PC 上的 WorkStep Web/daemon。依赖 Electron 或宿主桌面的能力必须显示“不支持远程操作”或提供经过授权的替代流程，不能把浏览器请求退化成任意本机命令。

### 7.1 我的项目

项目列表分组：

- 本机项目：沿用现有项目列表和目录行为。
- Gateway 授权：其他宿主 PC 发布，并由管理员直接或通过用户组授予我的平台远程项目。

Gateway 远程项目展示宿主 PC、在线状态、授权来源和 `read/edit` 级别，不展示宿主机绝对路径。本机项目保持当前展示方式。

### 7.2 本机项目与任务创建能力

平台模式不修改现有项目创建和目录选择流程。用户直接打开本机 WorkStep 时，仍可以使用当前方式创建、打开和管理本机项目。

任务创建单独受 `task.create` 控制：有权限时复用现有本机任务创建接口；没有权限时前端隐藏或禁用入口，后端任务创建服务返回明确的权限错误。Gateway 远程项目还必须对当前用户具有直接或用户组继承的 `edit` 授权；`read` 授权不能创建或修改任务。

### 7.3 发布、访问授权与平台分享

本机项目设置中增加“发布到 Gateway”；发布后由管理员向 Gateway 用户或用户组授予 `read/edit`。任务页面继续提供平台公开分享，不显示现有点对点远程项目分享串入口。

管理员可执行：

- 搜索平台注册用户或用户组。
- 添加、移除项目访问授权，并选择 `read` 或 `edit`。
- 授予或撤销项目范围的 `task.create`。
- 取消发布但不删除本机项目。

普通获授权用户只能按 `read/edit` 级别使用远程项目，不能修改访问授权名单。

任务公开分享沿用现有分享弹框的只读/交互、标题、密码和撤销交互，但请求发送给网关平台 API。生成结果为网关 URL，不再调用目标 PC 的 `/api/task-share/...` 公共接口。

## 8. 本机项目与 Gateway 远程项目访问流程

本机项目：

```text
Desktop loopback 会话
  → daemon 验证当前 Gateway 用户和签名能力快照
  → 按现有本机项目注册表解析项目
  → 创建任务时额外检查 task.create
  → 提交到现有项目数据库执行器
```

Gateway 远程项目：

```text
请求或 WebSocket 订阅
  → 解析登录会话
  → 得到当前用户
  → 根据 project_id 查询平台远程项目登记
  → 检查用户直接授权和当前有效组授权，得到 read/edit 级别
  → 创建任务时额外检查 task.create 的项目/设备/全局范围
  → 通过数据隧道把 device_id、project_id、访问级别和签名用户身份交给目标 PC
  → 目标 PC 从本机项目注册表解析真实路径
  → 提交到该项目数据库执行器
```

远程访问只携带设备 ID 与项目 ID；项目真实路径只能由宿主 PC 的本机项目注册表解析。Gateway 不读取、不保存也不修改宿主项目路径。本机访问继续使用现有项目选择逻辑。

需要接入统一可见性解析的入口：

- 项目列表和项目详情。
- 任务、工作流、助手、计划任务、频道。
- 历史消息、事件日志、统计和搜索。
- 文件浏览、上传、产物和 Markdown 图片。
- WebSocket 任务、会话和频道订阅。
- 项目导出。
- 平台公开分享创建、访问、交互和文件读取。

平台访问解析不得调用现有远程项目注册表或接受 `workstep://remote-project/...` 分享串。平台公开分享只接受网关 `platform_share` 及其短期分享会话；本地点对点远程项目和 daemon 直出分享只在本地模式启用。

## 9. 消息和审计改造

### 9.1 消息入口收拢

当前任务消息和聊天消息已经有部分作者字段，但覆盖不完整。实施时建立统一消息身份填充函数，并使所有持久化入口调用它。

要求：

- 用户消息缺少有效用户身份时拒绝创建。
- 助手、系统和定时器消息也必须写入明确 `author_type` 和作者名。
- 助手回复持久化本轮 `initiated_by`，不依赖读取当前请求上下文。
- API 历史响应和 AG-UI 自定义字段统一返回作者快照。
- 前端 `MessageMetaBar` 统一渲染本地或平台作者。

### 9.2 后台身份传播

不能只依赖 `ContextVar` 传播身份。任务启动时把身份快照写入运行记录；队列等待、daemon 恢复、定时器触发和子任务接力都从持久化快照恢复。

需要覆盖：

- `WorkflowRun`。
- 助手会话轮次。
- 定时计划。
- 人工审核和交互响应。
- 跨阶段任务分发。

### 9.3 审计动作

第一版至少记录：

- 网关初始化、数据库迁移成功或失败、桌面授权成功或失败、设备注册、撤销、解绑和迁移。
- 外部身份即时建号、登录成功、登录失败、退出、用户审核、禁用、外部身份绑定和解绑。
- 创建、注册、取消注册项目。
- 平台远程项目发布、分配变化和 `task.create` 能力变化。
- 创建、修改、归档、删除任务。
- 启动、排队、暂停、恢复、停止和取消任务或阶段。
- 人工审核、审批和交互答复。
- 定时计划创建、启用、暂停及触发。
- 平台分享创建、暂停、恢复、撤销、访问失败和交互操作。
- 消息创建失败等需要追责的异常。

普通消息正文仍以项目数据库为权威；审计表只保存消息标识和动作，不重复保存正文。

## 10. 前端全局状态

前端平台状态：

- `platform_initializing`
- `platform_unauthenticated`
- `platform_authenticated_no_device`
- `platform_authenticated`
- `platform_unavailable`

状态变化：

- 未初始化网关只允许引导管理员进入 `/platform/setup`。
- 未登录用户进入 `/login`，可以使用 Gateway 用户名密码或已启用的企业扫码入口。
- 登录后没有绑定 PC：进入 `/devices/empty` 下载并绑定客户端。
- 绑定完成或设备上线：进入 `/devices`。
- 用户被禁用：撤销会话并进入登录页。
- 当前 Gateway 远程项目访问授权被撤销：关闭远程项目内容并跳转“我的项目”；本机项目不受影响。
- 网关或平台数据库暂不可用：展示明确故障页，受管客户端不自动退回本地模式。

登录、用户管理、项目管理、审计和平台设置分别建立自管理组合模块；页面层只负责编排和路由，遵循现有前端拆分规范。

## 11. 实施阶段与验证

全程采用测试先行方式。每一阶段先增加失败测试，再实现最小功能使测试通过。

各阶段的依赖顺序、开发任务、接口边界与交付判据见[逐阶段开发计划](./platform-gateway-development.md)；本节保留总体阶段摘要。

### 阶段 0：独立应用骨架与协议边界

工作：

- 新建 `apps/gateway` 和版本化 `gateway-protocol`；在 daemon 中建立独立的 `services/gateway_client/` 包。
- 平台门户使用独立 `apps/gateway-web`，或在第一版作为 `apps/gateway/web` 子工程构建。
- 建立 gateway 与 daemon 客户端的兼容矩阵、协议协商和错误码。
- Desktop 只负责启动 daemon、生成桌面授权请求和处理 `workstep://auth/callback`，不增加第二个常驻进程。

验证：

- gateway 不导入 daemon 业务包；`gateway_client` 不绕过项目数据库执行器或直接复制业务实现。
- daemon 未配置网关时行为与当前版本一致。
- gateway 断线或 GatewayClientService 重连时 daemon 已运行任务继续运行。
- 协议版本不兼容时明确拒绝并报告，不以未知字段静默执行命令。

### 阶段 1：Gateway 数据库与受管状态

工作：

- 建立数据库后端抽象、逻辑模型、Alembic 迁移、连接池和事务边界。
- SQLite 作为第一版默认后端；通过同一模型和迁移基线保留 PostgreSQL 兼容测试。
- 在 gateway 建立平台运行状态；daemon 只读取本机受管状态的最小配置快照。

验证：

- 首次登录成功和设备撤销无需重启 daemon。
- 失败授权码兑换能原子回滚，不留下半写入会话或设备凭据。
- 状态更新过程中健康检查保持响应。
- SQLite 锁竞争不阻塞事件循环；统计写入饱和时登录、健康检查和设备心跳仍能及时响应。PostgreSQL 兼容测试覆盖迁移和基本事务，不要求第一版部署 PostgreSQL。

### 阶段 2：Gateway 用户体系与可选外部身份

工作：

- 首位本地超级管理员初始化及故障恢复身份。
- Gateway 自注册、Gateway 密码登录、审核、注销、禁用、密码修改与管理员重置。
- 钉钉、企业微信扫码回调、服务端身份换取和可选组织同步。
- 外部身份唯一映射、显式绑定、即时建号策略和会话恢复。
- 统一本地及平台操作者快照。

验证：

- 未登录无法进入平台业务页面。
- 关闭第三方连接器后，Gateway 自有账户、设备、项目、审计和 Gateway 密码登录仍正常。
- 禁用、过期和撤销会话立即失效。
- 外部身份回调具有 state、nonce、重放和回调地址校验。
- 同名、改名、中文姓名和多个企业租户不会造成账号覆盖或平台用户名变化。
- 禁止使用姓名、手机号或邮箱自动合并不同外部身份。
- 本地开放注册、注册后审核、关闭注册和第三方即时建号四种组合均有独立测试。
- 关闭自注册时，目录预同步用户扫码可直接登录，未同步用户扫码不会产生 `users` 或 `external_identities` 记录。
- 本地模式继续使用本地用户名和设备 ID。

### 阶段 3：设备注册、本机会话、策略下发与远程代理

工作：

- 建立 client release、desktop authorization code、设备注册、设备凭据和用户-PC 分配模型。
- daemon 的 `GatewayClientService` 使用常驻控制 WSS 连接网关，完成心跳、重连、策略、配置、命令、usage 和 audit 传输。
- Desktop 使用一次性 loopback 交换把设备作用域授权交给 daemon；daemon 建立本机会话并直接承载本机 HTTP/WebSocket。
- 建立签名权限快照、版本同步、撤销、离线 TTL 和 daemon 统一校验入口。
- 建立按需数据 WSS，以及 HTTP 请求/响应、文件和业务 WebSocket 流的多路复用协议。
- 网关创建短期签名访问票据，daemon 验签后生成平台操作者快照并通过 ASGI bridge 执行业务请求。
- 建立结构化设备命令、批量作业、幂等回执、进度回传和过期处理。

验证：

- 无绑定 PC 用户能获得正确系统和架构的网关统一签名安装包，下载链接不携带用户身份或绑定 token。
- authorization code 只能由持有匹配 PKCE verifier、state 和 `app_instance_id` 的客户端兑换；过期、重放或目标网关不匹配时拒绝。
- 登录完成后本机页面与业务 WebSocket 直接命中 loopback daemon，不产生 Gateway 代理流。
- 无本机会话、错误 Origin、过期权限快照和已撤销用户不能调用受管 API；前端显示与 daemon 判定一致。
- Gateway 断线时有效快照内的基础本地操作继续；过期后新供应商调用和其他受控动作 fail closed。
- 受管客户端不能从普通设置修改网关；解除或迁移会撤销旧设备凭据。
- 网关准确展示 PC 在线、离线、版本和最后连接时间。
- 没有整台 PC 授权的用户不能打开完整工作台；只有项目授权的用户只能建立绑定目标项目和 read/edit 级别的代理流。
- PC 位于 NAT 后且没有入站端口时仍可被已授权用户访问。
- HTTP 流式响应、上传、下载和 WebSocket 双向消息均可正确转发与取消。
- 账户禁用、设备取消分配或设备断线时，相关代理流及时关闭。
- 恶意浏览器不能伪造网关身份或跨设备重放访问票据。
- 批量安装能按并发上限调度；设为 1 时严格逐台执行，单台失败不阻塞其他目标。
- 命令重发不会重复安装，离线命令过期后不会突然执行，任意 shell 或未知动作会被 PC 拒绝。

### 阶段 4：供应商控制面、下发与用量账本

工作：

- 建立平台供应商、授权关系、配置版本、设备应用状态和用量账本模型。
- 通过控制 WSS 实现期望配置清单、差量同步、回执、撤销和失败重试。
- 生成按设备加密签名的供应商配置包，由 PC 复用现有配置写入、reload、测试和调用服务。
- 在 daemon 服务层禁止普通用户新增、修改、删除或覆盖受管供应商；本地自有供应商默认关闭。
- 把现有标准化 usage 事件映射为网关幂等用量记录。

验证：

- 未获分配的用户或 PC 不能发现或使用平台供应商。
- 配置重发、PC 重连和重复 usage 事件不会产生重复配置或重复计费。
- API Key 不出现在普通 API、WebSocket 日志、审计、项目数据库或前端状态中。
- 撤销或轮换后，在线 PC 原子应用新版本或删除受管配置并回传结果；失败时保留上一可用版本且显示风险状态。
- 每次调用只由实际执行 PC 生成一次用量事件，浏览器入口和中间转发节点不重复统计。
- 模型请求直接从 PC 发往供应商，Gateway 不接收或转发 Prompt、模型响应和流式事件。
- Token 和成本可按用户、PC、项目、供应商、模型汇总，并保留价格快照和计量来源。
- 网关数据库慢写、供应商网络延迟或 PC 回传阻塞时，FastAPI 事件循环健康检查仍及时响应。

### 阶段 4B：用户组与项目 Skills 下发

工作：

- 建立用户组、组成员/组长、外部部门映射和组项目关系。
- 建立 Skill 包、不可变版本、审核、组目录授权和项目分配模型。
- 扩展项目登记支持 `policy_only`，使项目接受组 Skills 策略但不自动开放远程访问。
- daemon 增加 `ManagedSkillSyncService`，把受管 Skill 安全落到现有 `.workstep/skills/` 与 manifest，并复用 `skill_center` 和现有引擎加载链。
- 增加用户组、平台 Skills、项目 Skills 来源及同步状态页面。

验证：

- 组长只能管理本组成员、关联项目和获授权 Skills，不能查看未分配的项目内容或修改其他组。
- 外部部门同步成员与 Gateway 本地组长/权限 overlay 不互相覆盖。
- 项目加入组管理不会自动成为远程项目；远程访问仍要求 `remote_published` 和管理员创建的用户/组访问授权。
- 受管 Skill 在下一次任务运行时被现有各引擎加载，运行中任务不热切换。
- 普通员工不能通过 UI 或直接 API 关闭、修改、覆盖或删除受管 Skill。
- 非受管同名 Skill 不被覆盖；冲突、错误和上一可用版本均可追踪。
- 路径穿越、越界符号链接、摘要不匹配、超限包和未审核版本被拒绝。
- 重复下发和设备重连保持幂等；撤销只删除带匹配受管标记的副本。

### 阶段 5：平台远程项目发布、分配与任务能力

工作：

- 建立平台远程项目发布登记，以及管理员维护的用户/组 `read/edit` 访问授权。
- 建立 `capability_assignments` 及签名策略快照中的 `task.create`。
- 本机项目继续复用现有创建、打开和目录处理流程。

验证：

- 平台模式不会改变本机项目路径或强制创建专用根目录。
- 未发布的本机项目不会出现在 Gateway 项目目录中。
- 没有直接或组授权的用户不能枚举或访问平台远程项目；项目授权不要求整台 PC 权限。
- 具有 `task.create` 的用户可以通过现有本机服务创建任务；缺少能力时，本机和远程入口都被 daemon 拒绝。
- 取消发布不会删除宿主 PC 的项目文件或数据库。

### 阶段 6：远程项目访问隔离

工作：

- 在 Gateway 远程项目解析和宿主 PC 代理入口接入分配检查。
- 远程项目列表、REST、WebSocket、文件和搜索复用检查；本机项目继续沿用现有解析器。

验证：

- 无权用户无法通过直接 `project_id`、WebSocket 订阅或文件地址访问项目。
- 用户只看见本机项目和 Gateway 分配给自己的远程项目。
- 管理员只能按管理 scope 查看已发布平台远程项目元数据，管理角色不自动授予项目内容访问权，也不会看到未发布的本机项目。
- 移除可见关系后，已有订阅立即停止接收项目事件。

### 阶段 7：消息作者完整性

工作：

- 扩充消息字段和迁移。
- 收拢任务消息与助手聊天消息持久化入口。
- 前端统一展示作者。

验证：

- 所有用户、助手、系统和定时消息的作者字段均非空。
- 平台消息记录登录用户名快照。
- 本地消息记录本地用户名快照。
- 后台回复能追溯原始发起人。
- 历史缺失作者显示“历史用户”，不被错误回填。

### 阶段 8：任务动作审计

工作：

- 建立统一审计服务。
- 接入任务生命周期、审核、定时器和项目访问授权变化。

验证：

- 启动、暂停、恢复、停止和取消均能查到操作者。
- 后台恢复和定时任务包含 `actor_type` 与原始发起人。
- 失败和拒绝操作也有结果记录。
- 审计元数据不包含敏感值。

### 阶段 9：注册、登录和客户端绑定页面

工作：

- 实现首位管理员初始化、本地注册/登录、钉钉/企业微信扫码登录、等待审核和扫码错误恢复页面。
- 实现无 PC 空状态、统一受管安装包下载、校验信息、桌面扫码登录和授权回调进度页面。
- 增加路由守卫与登录后返回。

验证：

- 各平台状态跳转准确。
- 扫码轮询或回调等待使用持续加载状态，成功、过期和取消不会混淆。
- 自注册关闭时隐藏注册链接；已同步用户扫码直接登录，未同步用户、待审核、禁用、身份源不可用和数据库故障均有清晰页面。
- 没有 PC 的用户不会进入空白工作台，绑定完成后能自动看到新 PC。

### 阶段 10：管理中心

工作：

- 管理概览。
- 用户管理。
- PC、连接状态和用户-PC 分配管理。
- 供应商、分配、设备同步状态和 Token 用量管理。
- 已发布项目管理，以及用户/组 `read/edit` 授权。
- 操作记录。
- 平台设置。

验证：

- 普通用户看不到且无法打开管理功能。
- 普通用户只能看到获得整台工作台授权的 PC；管理员只能查看管理 scope 内的 PC 和连接历史。
- 从设备列表打开 PC 后，页面所有 HTTP 与 WebSocket 请求均保持在同一设备作用域。
- 管理操作有确认、错误恢复和审计。
- 页面模块测试覆盖自己的状态、请求和校验。
- 大列表具备分页或服务端筛选，避免一次加载全部记录。

### 阶段 11：项目访问授权、平台分享与受管隔离

工作：

- 项目设置增加“访问授权”页签，展示用户/用户组来源和 `read/edit`；仅有管理授权者可修改。
- 平台模式下把任务公开分享切换为网关分享 API 和网关 URL。
- 在路由、API 和 UI 层隔离平台分享与本地点对点远程项目。
- 完成设备撤销、解绑、网关不可用和权限变化的实时处理。

验证：

- 管理员能把平台远程项目以 `read/edit` 授予用户或用户组，普通接收者不能修改授权。
- 平台分享能通过网关访问、交互、撤销和过期，目标 PC 不暴露公网地址。
- 平台模式不显示、不调用远程项目分享串生成或导入接口，也不会接受本地分享凭据。
- 标准本地客户端的远程项目和 daemon 公开分享行为保持兼容；受管模式与本地模式的数据和凭据不互相转换。
- 现有任务、画布、聊天、助手和计划任务无回归。
- i18n 所有词典键一致且非空。

## 12. 完成标准

- 本地客户端保持原有本地模式；受管客户端的网关归属来自签名安装包，只能通过管理员迁移、安装另一网关受管包或显式恢复出厂改变。
- Gateway 第一版使用 SQLite 单实例运行；数据层保留 PostgreSQL 选择并通过迁移兼容测试，但不把 PostgreSQL 作为第一版必需部署条件。
- Gateway 自有用户是平台身份权威来源，支持开放注册、管理员创建和 Gateway 密码登录；钉钉或企业微信只用于可选快捷建号/登录及身份绑定。
- 没有绑定 PC 的用户能从网关下载统一受管客户端；客户端扫码登录后通过 `workstep://auth/callback` 和 PKCE 获得当前用户会话并登记设备。
- 受管客户端的网关地址不能从普通设置修改；登录和权限同步经过 Gateway，登录后的本机 PC 界面通过 loopback 直接访问 daemon。
- PC 能通过配置网关地址主动连接，网关能显示在线状态和用户分配关系。
- 管理员能多选 PC 批量执行受支持的引擎管理动作，并逐台查看进度、结果和重试失败项。
- 网关能集中维护供应商、模型和价格，并只向授权用户与 PC 下发配置。
- 平台供应商配置签名下发并由 PC 写入现有供应商配置位置；普通用户不能通过 WorkStep 修改或绕过受管配置，凭据不得进入日志、审计或项目数据库。
- 每台 PC 的供应商期望版本、应用版本、同步状态和撤销状态可追踪。
- Token 用量通过 PC 持久化 outbox 批量上传，按用户、PC、项目、供应商和模型汇总；断线重传和批次重试不会重复计数。
- 获整台 PC 授权的用户可远程打开完整 WorkStep；仅获项目授权的用户不需要 PC 授权，但只能按 `read/edit` 访问指定项目。
- 本机项目沿用现有目录和创建方式，Gateway 不改变本机项目目录规则。
- 未明确发布的本机项目不会进入 Gateway；管理员可把已发布项目以 `read/edit` 授予平台注册用户或用户组。
- `task.create` 由 Gateway 按用户、设备或项目范围分配，并由本机 daemon 的任务创建服务强制校验。
- 安卓组、后端组等用户组可以设置组长；组长只能给本组关联项目分配平台已审核的 Skills。
- Gateway Skills 按固定版本和摘要同步到项目 `.workstep/skills/`，复用现有 Skill Center 与引擎加载链，普通员工不能修改受管副本。
- 平台模式下所有新公开分享均生成网关 URL；撤销、过期、密码和分享会话由网关统一管理。
- 平台网关隧道、项目登记和分享凭据与现有点对点远程项目完全隔离。
- 用户不能通过项目 ID、WebSocket、搜索或文件接口看到无权项目。
- 本地模式和平台模式下，每条新消息都有明确作者用户名或系统身份。
- 所有助手和后台消息都能追溯原始发起人。
- 任务启动、暂停、恢复、停止和取消均有持久化操作者记录。
- 撤销或解绑受管设备不会删除网关平台数据或 PC 项目文件。
- Gateway 数据库异步路径不阻塞事件循环，并覆盖 SQLite 锁竞争与统计写入背压；PostgreSQL 后端覆盖迁移兼容测试。daemon 新增的 Peewee 路径仍通过现有项目数据库执行器运行。
- 前端管理页面符合现有组件复用、弹框关闭保护、加载旋转和 i18n 规范。

## 13. 第一版暂不包含

- 级联网关、上下游路由和跨 Gateway 用户/项目管理。
- 除 `read/edit` 之外的项目细粒度角色。
- 除 `task.create` 等预定义能力外的通用接口权限编排系统。
- 邮件注册验证和邮件找回密码。
- 钉钉、企业微信以外的通用 OAuth、LDAP、OIDC 身份源。
- 用户磁盘或任务配额。
- Web 管理页热切换数据库后端，以及 SQLite 与 PostgreSQL 之间的自动在线迁移。
