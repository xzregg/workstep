# AGENTS.md

本文件为 AI 开发 在本项目中工作时提供指引。

## 分支约定

日常开发使用 `dev` 分支，后续开发从 `dev` 开始。完成并提交后，通过项目快捷按钮“合并到 main”将 `dev` 合并到本地 `main`，执行后返回 `dev`；远端推送按用户指令执行。

## 文档导航与权威来源

- `README.md` / `README.zh-CN.md`：面向使用者的项目首页与快速开始。
- `docs/README.md`：架构、开发和 GitHub 维护文档入口。
- `docs/code-map.md`：按功能定位 Web、API、服务与测试的入口。
- `PRODUCT.md` / `DESIGN.md`：产品定位与视觉系统。
- 本文件：Agent 执行约束和当前实现不变量；与代码冲突时以已验证的代码行为为准，并同步修正文档。

不要把完整架构或开发规范重新堆回首页 README；应更新对应 `docs/` 文档，并保持中英文首页链接可达。

## 用户操作手册同步（合并提交与发布检查）

- 官网操作手册位于 `apps/landing/src/manual/`，官网“文档”入口为 `#docs`；它是面向使用者的功能操作说明，技术架构仍维护在 `docs/`。
- 仅在将 `dev` 合并到本地 `main` 并提交本批代码的交付节点，集中同步本批已通过行为测试的用户可见功能对应手册章节：用途、真实入口、操作步骤、字段示例、完成结果和常见问题。删除功能须移除失效指引；不能把尚未实现的能力写成已支持。日常开发不要求每完成一个功能就更新手册或采集截图，手册变更随本批交付一起提交。
- 每个功能必须配真实界面截图。入口、字段、布局或结果状态变化时更新对应截图，保存在 `apps/landing/src/manual/screenshots/`，使用章节声明的截图 ID；截图不得包含密钥、个人对话、内部地址或私有项目内容。没有截图时登记缺口，不能用效果图冒充实际操作截图。
- 手册截图统一使用固定模拟项目“操作手册演示”和本机 `8777` 端口；配置目录为 `~/.workstep-manual-demo/config`，模拟项目目录为 `~/.workstep-manual-demo/projects/storage-demo`。启动与复用方法见 `docs/manual-demo.md`，不得使用日常项目或复制真实凭据。
- 入门教程优先通过界面下载 SDK 引擎，再说明供应商/认证配置、连接验证和默认执行配置；CLI 作为其他接入方式介绍，不要求新用户先安装 CLI。
- 合并提交节点须核对手册与本批已验证版本一致，运行官网测试、构建及 `yarn --cwd apps/landing manual:check`。截图或指引缺失时登记缺口，不得宣称文档已完成。发布检查复核已合并提交版本的手册；发现遗漏时集中补齐受影响章节和截图，不另行要求开发中的每个功能逐项触发文档流程。


## 项目概述

本仓库包含 **WorkStep** 的可运行应用、桌面端、官网与技术文档。WorkStep 是一个本地优先的工作流编排工具，将多个 CLI、SDK 与 ACP LLM 引擎串联为可定制的研发管道。

当前项目主要包含：
- `apps/daemon` — Python + FastAPI 本地后台服务
- `apps/web` — React + TypeScript + Vite Web 前端
- `apps/desktop` — Electron 桌面端与内置后端打包
- `apps/landing` — 产品官网
- `docs/`、`plans/` — 产品、架构、开发与实施文档

## 目录结构

```
apps/            # 可运行应用（daemon、web、desktop、landing、android）
ui/DESIGN/       # 设计系统静态参考页
docs/            # 架构、开发与维护文档
plans/           # 功能设计与实施方案
scripts/         # 仓库检查、发布与维护脚本
AGENTS.md        # 本文件
```

## 应用目录

### `apps/daemon`

WorkStep 本地后台服务，最低支持 Python 3.11，使用 FastAPI、Peewee 构建，负责 REST API、WebSocket 实时事件、项目管理、工作流编排、LLM 引擎调用与 SQLite 持久化。默认开发环境、CI 与桌面打包使用 Python 3.12，Docker 运行时使用 Python 3.14；调整版本时须同时核对 `pyproject.toml`、`.python-version`、CI、Dockerfile 与桌面打包脚本。

主要目录：
- `api/` — API 路由与接口
- `services/` — 业务逻辑、DAG 调度与任务执行
- `engines/` — LLM 引擎及 ACP、CLI、API 适配
- `agent_assistants/` — 助手模块（每个助手一个文件，通用层在 `base.py`）
- `models/` — Peewee 数据模型与迁移
- `schemas/` — Pydantic 请求、响应模型
- `streaming/` — 实时事件总线
- `tests/` — 后端测试

开发命令：

```bash
cd apps/daemon
uv sync --dev
uv run --no-sync uvicorn main:app --reload --port 8765
uv run --no-sync pytest
```

### 后端异步 I/O 开发规范

- **所有可能阻塞的 I/O 均不得运行在事件循环线程**：文件、网络、数据库、子进程管道及同步 SDK 等 I/O，禁止在 `async def`、FastAPI 异步路由、WebSocket 处理器或后台协程中直接同步执行；优先使用原生异步接口，无异步接口时必须通过 `asyncio.to_thread`、项目数据库执行器或专用执行器隔离。同步辅助函数可以执行 I/O，但其所有异步调用路径必须保证已进入执行器；仅声明为 `async def` 或放入后台协程不构成隔离。
- **阻塞回归必须有 canary**：新增或修改可能阻塞的 I/O 路径时，使用慢盘、网络延迟、慢 SDK 或锁竞争模拟，并配合健康检查或轻量协程证明事件循环仍可及时响应。

### Peewee 异步开发规范

- **Peewee 一律异步隔离**：Peewee 是同步 ORM；任何 `async def`、FastAPI 异步路由、WebSocket 处理器和后台协程都不得直接执行查询、迭代惰性查询、写入、删除、事务或数据库连接操作。
- **项目数据库统一入口**：每个项目的完整同步数据库工作单元必须封装为普通函数，并通过 `await project_manager.run_db(project_id, operation)`（或已注入的 `ProjectDatabaseExecutor.run`）执行。查询物化、事务、模型序列化都必须在该工作单元内完成。
- **跨项目与初始化**：跨项目读取应按项目分别提交到各自数据库执行器，可用 `asyncio.gather` 并发等待；项目注册、初始化等尚无项目执行器的操作才可使用 `asyncio.to_thread`，禁止退回事件循环线程执行。
- **禁止跨线程异步混用**：不得在数据库工作线程中调用 `asyncio.create_task`，不得让数据库激活上下文跨越 `await`。需要启动后台任务时，必须拆成“数据库线程持久化 → 返回纯数据 → 事件循环创建任务”。
- **回归要求**：新增或修改 Peewee 调用路径必须增加真实 API/WebSocket/后台调度测试，并用慢 SQL 或 SQLite 锁竞争配合健康检查 canary，证明数据库繁忙时事件循环仍可响应。

### `apps/web`

WorkStep Web 前端，使用 React、TypeScript、Vite、React Flow 和 Zustand 构建，包含任务列表、任务详情、工作流画布与设置页面。

开发命令：

```bash
cd apps/web
yarn install --frozen-lockfile
yarn dev
yarn test
yarn build
```

### 其他应用

- `apps/desktop` 的开发与打包命令以其 `README.md` 和 `package.json` 为准。
- `apps/landing` 的命令以其 `package.json` 为准。
- 静态设计参考页为 `ui/DESIGN/index.html`，不代表当前可运行前端功能。

## 前端开发规范（`apps/web`）

- **功能定位**：增加功能或移动功能职责时，同步更新 `docs/code-map.md`，写明功能入口、实际职责所有者、相关 API/服务和行为测试入口；Code Map 是 AI 修改代码的首站，不允许只在提交说明中描述新位置。
- **样式可定位**：固定布局、尺寸、颜色及状态样式写在 CSS 中，用有语义的 `className` 或 `id` 定位；JSX 的 `style` 只用于运行时计算值（如拖动比例或步骤颜色），且只传动态属性，禁止用内联 `style` 写死静态规则。复用控件优先使用组件和共享 CSS 规格。

- **优先复用**：同一 UI 出现两次即抽公共组件并统一默认值，禁止复制实现。现有入口：消息用 `ChatMessageBubble` + `MessageMetaBar` + `MessageResponseFooter`；输入用 `ChatInput`（配置菜单用 `CoordinatorConfigBar`）；Markdown 编辑/展示用 `MarkdownEditor` / `MarkdownMessage`；确认用 `ConfirmDialog`。
- **页面与布局职责**：`Layout` 和页面层只负责路由级数据选择、区域编排与少量跨区域协调，不得内联实现完整业务流程。一个弹框、侧栏分区或编辑器只要同时拥有独立状态、异步请求、校验和确认交互，就应抽成自管理的组合模块；调用方只传稳定标识和结果/关闭回调，禁止为了“拆文件”透传整组 state/setter。文件超过 800 行、局部状态超过 15 个或 effect 超过 10 个均视为拆分信号；现有超限文件属于待治理技术债，修改时不得继续加入新的独立业务职责或显著增加复杂度。新增复杂流程必须先抽离模块；确实无法拆分时须在变更说明中写明理由。
- **模块测试归属**：行为测试应面向实际拥有该行为的模块，不得把页面源码文本当成所有子功能的测试入口。页面层只测试模块是否正确组装；状态、请求、校验、关闭保护和错误恢复由组合模块自己的测试覆盖。重构移动职责时同步迁移测试目标，避免测试反向阻止合理拆分。
- **任务详情与分享页**：两者共用 `TaskDetailPage`，新增查看类能力须加入 `TaskDetailReadCapabilities`，由任务详情和分享页分别实现，并覆盖分享会话下的行为；分享模式只控制消息输入能力，不能以缺少分享页接口为由隐藏查看功能。
- **交互与校验**：禁用原生 `alert/confirm`。必填项为空时提交类按钮禁用；触发类按钮（如「AI 创建」）可点击，但须在弹框固定高度区域提示、聚焦缺失字段。侧边面板有改动时，关闭前用 `ConfirmDialog` 确认；无改动时遮罩点击直接关闭。
- **命名**：新建/重命名项目与工作流时禁止空白字符，前端即时校验，后端 schema 同步强制。
- **流程与模板**：新项目默认没有流程，初始化和重新打开时均不自动创建默认流程；已有流程原样恢复。新流程默认空画布，模板由用户主动选择。模板以 `~/.workstep/data/templates/*.json` 为准；启动时从 `apps/daemon/data/templates/` 复制缺失文件但不覆盖。模板含 `id/name/description/steps`；内置模板标记 `default: true` 且不可删除。
- **助手架构**：所有新助手和后续助手能力扩展必须建立在同一套基础设施上，禁止复制会话、流式事件、停止、引擎配置或聊天 UI 实现。后端通过 `agent_assistants/base.py` 的 `AssistantConfig` 注册并复用 `AssistantRuntime`，仅提供助手自己的 system prompt、上下文构建、结构化结果解析/校验和发布逻辑；创建态会话默认仅内存，需要跨重启恢复时才增加持久化适配器。前端通过 `createAssistantStore(config)` 创建配置实例，统一使用 `AssistantChatPanel`、`ChatMessageBubble`、`MessageMetaBar`、`MessageResponseFooter` 和 `ChatInput`；助手特有 UI 只通过组合插槽或薄包装组件扩展。每个助手必须使用独立 WebSocket `channel` 并按 channel 分流，结构化结果通过通用 store 的 `resultEvent` / `proposalEvent` 配置接入，不得让其它助手 store 接收。AI 流程助手统一用 `AiFlowChat`；方案选择必须呈现可点击的提案卡片（标题、步数、摘要、应用态）。新增助手必须覆盖会话隔离、结构化结果、停止、错误、无意外落库及既有助手回归测试。
- **聊天与 Markdown**：任务对话和 AI 流程助手共用上述聊天组件，不得覆盖 `ChatInput` 的统一高度或重复实现上传/粘贴。Markdown 图片上传至项目 `.workstep/uploads/`，正文保存项目相对路径，并由 `MarkdownMessage` 映射预览地址。
- **Mermaid 性能红线**：消息中的 Mermaid 围栏必须动态加载渲染器，并仅在流式结束且内容稳定后渲染；禁止静态导入 Mermaid 或在流式刷新期间生成图表。渲染结果须缓存，失败时回退显示源码。
- **布局与样式**：新做的桌面端弹出窗口须支持从四边和四角拖动改变大小，并限制最小尺寸及视口边界；移动端可保持全屏或自适应布局，不显示缩放拖柄。复杂弹框顶部放表单，主区域占满余高、支持分隔拖动；避免写死过矮高度。公共组件放入 modal 后须检查全局表单样式污染，必要时提高选择器特异性并人工核对。
- **状态与视觉**：异步处理中状态必须配持续旋转图标，结束、暂停或等待用户时停止。`ChatInput` 的发送/停止、附件选中态和配置菜单样式以组件现有实现为准，不在调用处另行定制。
- **图标按钮**：按钮直接内联 `svg`/`Icon` 时必须显式 `padding: 0`（或按设计给最小内边距），禁止依赖全局 `button` 默认 padding（`4px 8px`），否则固定尺寸按钮的内容区被压缩、图标被裁剪。
- **复选框**：原生 `input[type="checkbox"]` 必须使用全局紧凑规格，默认可见尺寸统一为 `16px × 16px`，特殊密集选择场景最多 `18px × 18px`；禁止继承文本输入框的 `width: 100%` / `height: 32px`，也禁止通过放大可见方框满足触控尺寸。需要扩大点击区域时应使用 `label` 或外层容器提供命中范围，复选框本体仍保持紧凑。
- **移动端适配**（`apps/web/src/mobile.css`，断点 `≤1023px`）：
  - 普通可见控件使用 `--mobile-control-regular` 的 32px 高度；菜单项和需要更大点击区域的控件使用 44px 变量。消息操作按钮（`.chat-message-action`）和浮层小按钮（如 `.conversation-new-messages-button`）保持紧凑。新增尺寸须复用 `mobile.css` 的共享变量，不写单独的像素高度。
  - 修改任务详情头部的按钮或信息时，必须整体检查标题、状态、创建者、时间、绑定 BOT、分享、任务 ID 和关闭入口在 320px、390px 及 1023px 宽度下的排布；移动端头部信息优先在两行内显示，创建者和时间保持可见，长文本可限宽滚动，不能因新增按钮把任务 ID 挤到第三行。长 ID 须限制占用宽度并保持完整值可查看、可复制；使用跑马灯时兼容 `prefers-reduced-motion`。除行为测试外，还须在窄屏实际渲染中核对换行、按钮高度和点击区域。
  - `.btn-ghost` 在消息区域（`.chat-message-row`、`.process-trace-thinking-copy`、`.llm-tool-call`）内必须去掉 border、强制 `min-height/min-width: 24px`，避免 ghost 边框在小按钮上显得过大。
  - 思考中 / 运行中的消息（`[data-thinking]`、`.message-footer--running`）隐藏操作按钮；已完成消息的操作按钮始终可见（移动端无 hover，不依赖 `opacity: 0 → hover: opacity: 1`）。
  - 新增消息区域内的可交互按钮时，必须加 `chat-message-action` class 以复用移动端样式规则；新增类似的小尺寸图标按钮容器须在 `mobile.css` 的 ghost 按钮选择器中补充覆盖。
- **i18n**：新增文案先写 `zh-CN.ts`；其他词典可暂用中文占位，但键集合必须一致且非空（由 `apps/web/tests/i18n.test.ts` 校验）。
- **禁止重复 API 请求**：同一组件内多个 `useEffect` 不得对同一 API 发起可重叠的请求。具体规则：
  - 新增 `useEffect` 触发 API 调用前，检查同一组件（及父级 Layout 等）是否已有 effect 在相同或更大依赖集上调用同一接口。若有重叠，合并为单一 effect 或移除冗余。
  - effect 依赖数组中只放**真正影响该请求结果**的变量。例如：加载助手配置的请求结果不随 `sessionParam` 变化，则不应把 `sessionParam` 放入该 effect 的 deps。
  - 若同一数据需要被多个触发条件刷新（如事件信号 A、B、C 都需刷新列表），合并为一个 effect 以联合信号为 dep，或在 store 层做 in-flight 去重（如 `listLoading` guard），避免同 tick 内多次 fetch。
  - 新增功能时若需新增数据加载逻辑，优先复用已有 store action（其内部通常已含去重），而非在组件内新写裸 API 调用。

## 技术架构（已确定）

| 层 | 技术 | 说明 |
|---|---|---|
| Daemon | **Python + FastAPI** | 异步 API，WebSocket 实时推送，子进程管理 |
| ORM | **Peewee** | SQLite 友好，轻量 |
| 子进程 | **asyncio.subprocess** | 流式读取 LLM CLI stdout |
| 实时通道 | **WebSocket** | `/ws` 主事件流及分享、远程项目专用通道 |
| 内部事件 | **ACP 词汇** | 各引擎统一产出 ACP session update 对齐事件，`events.py` 定义（内部=ACP） |
| 对外事件 | **AG-UI** | WebSocket 实时推送与历史回放共用 `engines/core/agui.py` 翻译层（对外=AG-UI） |
| 前端 | React + TypeScript + Vite | 画布编辑器是核心约束；store 只消费 AG-UI 事件 |
| 数据 | **per-project SQLite** | 每个项目独立 `.workstep/workstep.db` |

WebSocket `/ws` 支持按连接订阅过滤（`{"type":"subscribe","task_ids":[...],"status_only_task_ids":[...],"session_ids":[...],"channels":[...]}`，`streaming/bus.py` 入队前按谓词过滤）；前端连接后主动订阅：打开的任务详情订阅全量流、当前项目任务订阅状态事件、活跃助手会话按 `session_id` 订阅，未订阅前保持全量广播向后兼容。

## 多引擎支持

`BaseLLMEngine` 负责安装、版本、二进制解析、配置表单与能力声明等 WorkStep 扩展；`AcpEngineBase` 提供统一的 spawn / session / interaction / approval 协议接口，所有引擎均继承它。引擎由 `engines/core/registry.py` 自动发现：在 `engines/` 一级模块或包中新增 `AcpEngineBase` 子类并声明唯一 `ENGINE_ID`，无需维护静态注册表。

当前实现包含 Claude Code、Codex CLI、Hermes ACP、OpenClaw、Claude Agent SDK、Codex SDK、Qoder SDK、DeepSeek Harness 与内置 Pydantic AI。完整能力矩阵以 `docs/architecture.md`、`docs/llm-engine-development-guide.md`、引擎类的 capability 声明及测试为准，AGENTS.md 不维护易漂移的传输与版本状态表。

ACP 原生引擎（如 Hermes）声明 `COMMAND` 即可复用基类协议实现；非 ACP 引擎用自己的传输实现 `spawn`，并完整实现等价会话与审批方法（`create_session` / `resume_session` / `close_session` / `cancel_session` / `approve_tool` / `approve_tool_option` 等）。没有原生入口的能力必须如实声明并安全降级，上层调用只依赖 `AcpEngineBase`。

各引擎声明 `acp_events` capability 元数据（**声明 = 实际**：有原生等价就映射，无来源不发、不合成默认值；
`tests/test_engine_base_hierarchy.py` 保证 `acp_events ⊆ ACP_EVENTS` 且映射路径产出的事件都被声明）；
非 ACP 引擎的 `request_permission` 在 `request_interaction` 中登记到基类 pending 审批注册表，
`approve_tool` / `approve_tool_option` 统一把决定写回挂起交互；Hermes 由 `AcpEngineBase` 直接产出并补全缺失 update 类型。

会话分叉能力通过 `supports_session_fork` / `fork_session` 独立声明，不能用 resume 模拟。当前 Codex SDK 使用官方 `thread_fork`；其它没有真实原生入口的引擎声明为不支持，并由会话聊天层使用显式的跨引擎上下文交接。

**子进程 stdout 必须分块读取**：CLI 引擎（Codex / Claude Code / Hermes）与通道桥接的单条 JSONL
事件（大段 tool 输出、长 assistant 消息、二维码 base64）可轻易超过 asyncio `StreamReader`
默认 64KiB limit，`readline()` / `async for line in stdout` 会抛
`Separator is not found, and chunk exceed the limit` 并**清空已缓冲数据**，导致整轮执行中断且日志丢失。
统一使用 `engines/core/stream_lines.py`：`iter_stream_lines(stdout)` 按行迭代，
需要超时轮询（如 Codex 轮询 live 消息队列）时复用同一个 `ChunkedLineReader` 实例
（`readline(timeout=...)` 超时保留不完整行，跨进程重建读取器需比较 `reader.stream`）；
单行超过 `max_line_bytes`（默认 256MiB）时切块并告警而不是中断。
`tests/test_stream_lines.py` 覆盖超长单行、超时保缓冲、真实子进程与 Claude/Codex 引擎级回归，
并守护「不得再用原生 readline 读子进程 stdout」。

Pydantic AI 的关键不变量：固定挂载 harness `Coder` 与项目 Skills 白名单镜像；项目记忆仅使用 `.workstep/MEMORY.md`；思考强度通过 `Thinking(effort=...)` 传递；上下文压缩、会话恢复与同会话检索统一使用 `TieredCompaction`、`WarnNearLimits`、`StepPersistence`、`ConversationSearch`，持久化到 `.workstep/harness_runs.db`。单次 run 的 `request_limit` 固定为 100，工具参数重试为 3；Coder shell 只能从项目根执行白名单命令，不允许用 `cd/bash/sh` 绕过。Planning 工具写入固定 `InMemoryPlanStore`，引擎发布去重后的标准 ACP `plan` 快照，并通过 `engines/core/plans.py` 归一状态。更具体的 Harness 行为以 `engines/pydantic_ai/` 及 `tests/test_pydantic_ai_harness.py` 为准。

事件边界的权威来源为 `apps/daemon/engines/core/events.py`、`engines/core/agui.py` 和前端 `src/utils/agui.ts`：引擎内部使用 ACP 对齐内容事件并保留必要的编排事件；未知 ACP update 通过 `acp_raw` 透传，旧 `events_json` 经 `map_legacy_event` 兼容。WebSocket 实时推送与历史回放必须共用 AG-UI 翻译层；前端所有 store 只消费 AG-UI，A2UI 使用 `CUSTOM{name:"a2ui.surface"}`，Markdown fence 仅作为旧消息回退。

## 数据模型

每个项目一个独立 SQLite 数据库：默认 `<项目>/.workstep/workstep.db`；取消“数据目录跟随项目目录”后使用 `~/.workstep/projects/<项目ID>/workstep.db`（环境覆盖沿用 `WORKSTEP_CONFIG_DIR`）。项目根目录始终保留 `.workstep/project.json` 稳定身份与存储模式；所有项目数据目录通过 `Project.workstep_dir` 或在线程内调用 `services/project_storage.py::data_directory` 解析，禁止重新写死根目录 `.workstep`。核心表：
- `tasks` — 任务（对应前端"卡片"）
- `task_steps` — 每步骤当前进度与引擎会话标识
- `workflows`、`workflow_runs`、`step_runs`、`review_runs` — 流程定义及执行/审核轮次
- `messages` — 任务消息正文、事件摘要与 JSONL 日志索引
- `chat_sessions`、`chat_messages` — 项目会话及消息；可恢复引擎会话标识保存在会话或步骤字段中
- `coordinator_sessions`、`coordinator_turns`、`action_proposals`、`stage_supplements` — 协调助手状态
- `schedules`、`schedule_runs`、`task_shares` — 定时任务与分享；`channels`、`channel_chat_mappings` 是已移除个人微信渠道的历史兼容表

完整表集合以 `apps/daemon/models/__init__.py::ALL_MODELS` 为准。产物不是 `artifacts` 数据表，而是项目 `.workstep/artifacts/` 下的文件与 manifest。

任务步骤执行的完整过程事件以项目 `.workstep/event_logs/task-<task_id>/<session_id>/<message_id>.jsonl`
为权威日志；`messages` 表只保留可见 `content`、必要的摘要事件、`event_summary_json`、
事件数量/末序号及 `event_log_path` 查询投影。历史接口默认返回摘要，详细时间线通过
`GET /api/task/{task_id}/messages/{message_id}/events` 分页读取；无 `event_log_path` 的旧
`events_json` 消息继续兼容回放。
