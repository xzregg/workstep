# 开发指南

## 诊断日志大小与保留期限

源码 `start.sh` 使用 Uvicorn 原生 `--log-config data/logging.json` 配置。框架／应用日志走 Python 标准库 `QueueHandler → QueueListener → RotatingFileHandler`：只保留一个标准库写盘线程，附 UTC 时间和异常堆栈；不自建管道、stdout/stderr 读取线程、轮转循环或监测线程。少量扩展仅负责保留天数、UTF-8 字节预算及业务日志兼容。原生文件描述符输出交由桌面／容器／服务管理器处理，不再由 daemon 劫持。保留 `uv --no-sync` 引擎 SDK 环境。配置以下环境变量，或放进根目录未提交的 `.env`，下次启动生效；目前不提供设置页：

```dotenv
WORKSTEP_LOG_MAX_MIB=5
WORKSTEP_LOG_BACKUPS=9
WORKSTEP_LOG_RETENTION_DAYS=14
WORKSTEP_LOG_RECORDS_PER_SECOND=100
WORKSTEP_LOG_KIB_PER_SECOND=256
```

大小范围 1–1024 MiB，备份 0–99 份，期限 1–3650 天。默认每个诊断流单文件最多 5 MiB，含当前文件最多 10 份／50 MiB，备份按日期和大小滚动，超过 14 天删除；大小／份数先达到时，可能保留不到 14 天。旧的超大日志只读取末尾，不把整个文件载入内存。后台写盘与清理不阻塞事件循环；输出队列有界，洪泛时保留近期输出并记录省略提示。

性能边界：队列最多 512 条，每条消息正文最多 64 KiB，入队前／格式化后均限制长消息；不截断格式模板中的占位符。不同文件使用独立锁，历史目录扫描不持有全局写盘锁。每次 Action 复用一个标准文件 handler／句柄，按间隔检查保留策略，结束时在线程池关闭，避免每 4 KiB 输出都打开文件并扫描备份。日志线程退出排空最多等待 5 秒；仅在进程已经退出／发生未捕获的致命异常时，排空超时以失败状态结束退出，允许丢弃余下日志，防止标准 logging 退出清理继续等待故障存储。不会因运行中的普通日志拥塞主动退出业务服务，也不会新增退出监测线程。

写盘额度：默认每个持久诊断流按秒窗口最多写入 100 条、256 KiB 格式化文本；正常等级最多使用 80% 条数及 50% 字节额度，为 ERROR 及以上预留空间。超过额度汇总省略，在后续可写日志中提示，不等待磁盘、不增加线程；这限制的是诊断日志，不限制会话事件、业务数据库或引擎自身的数据写入。速率配置范围为 1–10000 条／秒、64–16384 KiB／秒。文件写入或格式化报错时采用 60 秒冷却，避免刷屏式重试与错误堆栈放大 I/O。

故障隔离：日志配置无效时使用默认值并报告；启动时日志目录不可用则降级为宿主标准错误输出，保持 Uvicorn 启动。Action 侧诊断文件失败会停用该次运行的文件写入，界面输出与业务执行结果继续保存；日志关闭失败也不改写业务结果。隔离进程测试见 `tests/test_runtime_logging_faults.py`，覆盖日志满盘、权限、轮转、生产端／消费端格式错误、卡死写盘、清理失败、启动目录错误和配置错误，同时验证健康接口、请求异常后的继续服务及 SQLite 业务提交。真实 WorkStep 任务 API 的日志失败回归位于 `tests/test_action_runtime.py`。这些模拟只隔离日志故障；若整个卷写满／硬件故障，业务数据库本身仍可能受影响。

该故障测试还以全新临时 `WORKSTEP_CONFIG_DIR` 启动真实 `main:app` 的完整 daemon 生命周期，注入日志满盘／启动目录不可用，验证 `/api/health`、`/api/project/list` 及退出归属记录清理；不操作正在使用的后台或真实用户配置。

多会话验证见 `tests/test_logging_chat_concurrency.py`：16 个会话经真实聊天 API 同时执行，使用受控引擎流式返回，真实保存用户／助手消息和事件；4 个测试线程同时刷诊断日志，在慢盘／写入不可用时检查健康接口、会话结果和内容隔离。另以 8 个日志生产者并发关停验证标准 listener 退出。`RecentQueueHandler` 在停止期间不得逐出 QueueListener 的退出哨兵；Runtime 的重复 close 串行且幂等。该覆盖限定为单 daemon 多会话，不代表真实模型网络、长时间负载或多个进程共写同一日志文件已验证。

| 日志 | 保留与查看 |
| --- | --- |
| `logs/daemon.log`、`.1`…`.9` | 正常后台、启动过程和错误堆栈；默认每流 50 MiB／14 天，启动和写入时检查过期文件，空闲时不轮询。交互启动用 `tail -F` 跟随轮转。 |
| `logs/restart-action.log` | 每次取得重启锁后换成新文件，执行器的阶段与错误通过标准 logging 写入，最多一个配置大小的文件；预检命令仅在失败时记录最后 64 KiB 输出，不另起采集线程，不跨尝试累加，旧句柄隔离。 |
| `logs/web.log`、备份 | 仅开发前端；在普通日志写入时顺带检查，最多每分钟一次，不建立监测线程，按同一策略复制末尾并截断当前文件，前端以 O_APPEND 写入，避免稀疏文件。未触发检查前可暂时超过阈值；复制／截断窗口可能丢失少量开发诊断。 |
| 项目 `action-runs/*/output.log`、备份 | 每次运行按上述大小限制；30 秒后开始、之后每小时清理未运行的历史输出，每项目历史输出合计默认最多 50 MiB／14 天。运行中的输出不按项目历史预算删除，仍受单次运行文件限制。UI 原有最近 100000 字符输出继续保留。 |
| 桌面包日志 | 继续由 Electron diagnostics 收集，默认每流 5 MiB、3 份备份；崩溃转储另外按年龄、份数和总量清理。本次不替换桌面 READY 协议输出。 |
| Docker Compose 控制台日志 | `json-file`，每份 5m、最多 10 份；这是大小／份数上限，不是按天保留。已有容器需重新创建后采用驱动设置。 |
| `event_logs/**/*.jsonl` | 会话／任务事件历史，可持续增长，不适用诊断轮转；普通会话删除会连同其事件文件删除。不得直接按诊断期限清理，以免破坏历史与回放。审计数据库另有 30 天保留策略。 |

查看近期后台错误可搜索 `rg -n 'ERROR|Traceback|Exception' logs/daemon.log*`，结合相邻行查看完整上下文；日志是 UTF-8 文本，可直接用编辑器打开。保留范围之外的旧记录无法恢复。

只运行 daemon 时可在 `apps/daemon` 使用 `WORKSTEP_LOG_DIR=/absolute/logs uv run --no-sync uvicorn main:app --log-config data/logging.json --port 8765`。未使用此日志配置、也不指定 `WORKSTEP_LOG_DIR` 的手工 Uvicorn 命令仍输出到控制台，文件保留由外部服务管理器负责。

## 从功能找到代码

先看[功能代码地图](code-map.md)，再在职责所有者内查调用链和测试。页面负责组装，领域 API 放入 `apps/web/src/api/` 的对应模块；后端路由、服务、schema、模型分别放在 `apps/daemon/api/`、`services/`、`schemas/`、`models/`。`src/api/client.ts` 兼容已有导出，不作为新领域逻辑的默认入口。

新增功能或移动职责时，必须同步更新 Code Map 的功能描述和入口，明确测试位置。前端固定样式使用有语义的 class 或 id 写入 CSS；只有运行时计算的值可用 JSX `style`，且只保留动态属性。优先复用现有控件的尺寸和视觉规则。

文件超过 800 行、局部状态超过 15 个或 effect 超过 10 个提示检查职责，但不要求拆到固定行数以下。按独立行为和数据边界抽模块，让模块自己管理请求、校验、错误与关闭保护；不要只把 JSX 搬走，再从页面透传一组 state/setter。重复实现出现两次时优先复用现有组件或领域服务。

## 后端 I/O 与并发

`async def` 中的文件、目录、网络、数据库、同步 SDK 和子进程 I/O 都不能直接阻塞事件循环。优先原生异步 API；没有时把**完整同步工作单元**交给 `asyncio.to_thread` 或专用执行器，包括路径检查、文件打开/关闭、迭代、事务和序列化。Peewee 项目数据库工作单元统一用 `project_manager.run_db(project_id, operation)`；不要让惰性查询或数据库上下文跨越 `await`。子进程 stdout 使用 `engines/core/stream_lines.py` 分块读取。

修改 I/O 路径时写慢盘、慢 SQL、网络延迟或锁竞争回归，并在慢操作进行时测轻量协程或健康检查是否及时响应。静态搜索只能辅助定位，不能代替真实调用路径测试。详细约束见 [Daemon 指导](../apps/daemon/AGENTS.md)。

## 托管资源下载

语音模型、运行库和沙箱安装包等由 WorkStep 管理的资源，按以下方式接入。

- **普通文件**由调用方提供可信 URL、稳定资源 ID、预期哈希，以及已知时的文件大小。Daemon 复用 `services/resource_download.py::ResourceDownload`，桌面主进程复用 `src/resource-download.cjs::downloadFile`。桌面安装可先于 daemon 启动，两者各自在宿主运行环境内下载。
- 部分文件按资源标识和哈希隔离。暂停、网络中断或宿主重启后保留字节，下次启动从已写入的位置请求 HTTP Range。收到的范围必须匹配请求；下载源忽略 Range 时只重下该文件。完整校验通过后才交给安装方，损坏的缓存应移除。
- 任务由宿主管理模块持有。进度至少提供已接收字节和可为空的总字节数，页面退出只停止观察；恢复操作重新提交同一资源。支持暂停的入口应等待写入停止再返回。清理入口只删除所选资源的下载缓存，保留已安装内容和其他任务。
- **在线 OCI 镜像**走容器引擎拉取和镜像检查。桌面沙箱复用 `sandbox.cjs::acquireReleaseImage`，复用镜像层由 Podman 管理；下载进度未知时只展示阶段。按文件断点续传适用于独立发布且可校验的镜像归档。
- 修改下载行为时用模拟源覆盖中断、恢复、Range 不可用、校验失败和清理范围。需要用户操作时，界面只提供对应任务实际支持的操作。

## 文件描述符与数据库连接

`start.sh` 和 `start-gateway.sh` 共用 `scripts/file-limits.sh`，启动时默认将文件描述符软上限提高到 4096；可在 `.env` 或启动环境设置 `WORKSTEP_NOFILE_LIMIT=8192`。脚本不降低已有更高上限，不超过系统硬上限，并输出实际值。配置由随后启动的后端及子进程继承，已运行的进程须在下次重启后生效。`main.py::lifespan` 同时调用 `services/resource_limits.py::configure_file_limit`，让直接运行 uvicorn 和桌面包内后端也采用相同默认值；macOS/Linux 只提高软上限，Windows 没有 POSIX `RLIMIT_NOFILE` 时跳过。桌面包需要重新构建安装才能获得新代码。

daemon 的专用 `ProjectDatabaseExecutor` 每个项目复用一个线程本地连接，在关闭执行器时释放；临时同步 `ProjectContext` 仅关闭自身打开的连接，嵌套上下文和调用者已有连接保留。项目初始化／重新注册完成后关闭初始化线程的连接，迁移失败同样释放。gateway 的异步连接池保持有界复用，SQLite 备份使用显式关闭的源／目标连接；`sqlite3.Connection` 的普通 `with` 只管理事务，不保证关闭连接。

无项目流程助手的 `services/global_sessions.py` 使用串行首次初始化，初始化与临时会话上下文均释放自身连接，嵌套上下文保留外层连接；回归为 `test_global_sessions.py` 与 `test_workflow_gen.py`，慢初始化 canary 验证事件循环仍可响应。

排查 `Too many open files` 时，用 `lsof -nP -p <PID>` 区分数字 FD 与 `txt` 映射；`.db`、`-wal`、`-shm` 都占描述符，同一项目跨临时线程出现大量 `.db` 重复项时检查工作单元的关闭路径。回归入口为 daemon `test_project.py` / `test_api_contracts.py`、gateway `test_database.py` / `test_startup_script.py` 和 `scripts/tests/test_file_limits.py`。

## 前端控件与样式

后台、桌面和前端源码中的错误使用可读英文。Web 工作台和网关页面通过 `packages/gateway-ui/src/errorText.ts` 翻译已登记的错误模板。新增用户可见错误时同步登记英文、简体中文及其他内置语言。模板占位符按 `{p0}`、`{p1}` 编号，保留现有文案 ID 供自定义语言包沿用。控制流优先依据状态码或异常类型。展示层保留无法识别的上游错误。

优先用 `Button`、`Input`、`Select`、`Textarea`、`ChatInput`、`ConfirmDialog` 等共享组件，设计规则见[统一设计规范](../DESIGN.md)。移动端普通可见控件统一为 32px，高点击区域和菜单项用 44px；使用 `src/mobile.css` 的 `--mobile-control-*` 变量，不在页面样式写一次性高度。消息操作按钮保持紧凑；图标按钮要有明确内边距。新增文案先写 `zh-CN.ts`，所有词典键集合保持一致且非空。

组件新增请求前检查页面、父级和 store 是否已有同一请求；合并重叠 effect 或复用去重的 store action。行为测试跟随拥有状态和请求的组件，页面测试组装。

## 任务详情的模块边界

任务详情与分享页共用 `TaskDetailPage`、`TaskDetailReadCapabilities`。消息归并、排序和最新消息索引由 `components/taskConversationFeed.ts` 持有，未读、跟随、历史分页和内容尺寸变化由 `hooks/useTaskConversationScroll.ts` 管理；通用滚动规则位于 `utils/conversationScroll.ts`。请求、错误和交互跟随实际职责所有者测试，页面只验证组装。

后续拆分消息卡片、审核或编辑器时，应先缩小稳定输入和回调，不透传整组页面 state/setter，也不把历史设计草图当成已实现接口。流程恢复的数据库工作单元及事件循环职责见[恢复线程边界](workflow-engine-execution.md#恢复决策的线程边界)。

## Git 管理的现行边界

生产 Git 工作区使用真实仓库，开发 `/prototype/git` 页面只使用模拟数据，不进入生产构建。项目头部入口复用 `ProjectGitButton`；点击分支浏览，显式切换才改变工作目录。工作区、提交草稿和选择按目录保存，文件对比打开独立弹窗，不把 Git 业务状态放进页面布局层。

### 仓库发现与设置

`git_scan_depth` 是全局设置，默认 5；项目根为第 0 层。扫描只从已注册的本地项目开始，在限深范围识别 `.git` 目录或文件，按规范化 Git common directory 去重，并加入 Git 登记的外置 Worktree。发现嵌套仓库后继续按深度扫描；不进入 `.git`、`.workstep`、`node_modules`、`.venv`，不跟随子目录符号链接，不隐式 prune。

扫描异步、有界执行；配置及项目列表变化后刷新，旧代次不能覆盖新结果。不可访问目录独立报告，不让一个失败中断其它项目。文件 I/O 进入执行器，Git 使用受控异步子进程；同仓库写操作按 common directory 串行化，读取可并行。

### 文件审阅与提交

默认勾选已跟踪修改及已有暂存内容，新文件由用户明确选择。提交单位是所选文件的完整当前内容，重命名包含新旧路径，不提供按 hunk 提交。提交前检查 HEAD、状态和审阅快照；文件再次变化时重新审阅。

后端用字面 pathspec、参数数组及 NUL 分隔文件列表处理特殊或大量路径，说明通过 UTF-8 文件传递。只暂存及提交所选路径，未选文件和既有暂存保持原状；保留 hooks、签名与身份检查。失败保留说明和选择，刷新真实状态，不隐式 reset；已有新提交时先核实 HEAD 再决定是否重试。

差异提供行号、hunk、作者及日期，新增行不伪造历史归属。二进制、无 HEAD、删除文件及大文件有明确降级；当前文本预览上限为 2 MiB、差异 20,000 行，历史分页每页 50 条。历史内容只读，不能混入待提交选择。

### 分支、远程与合并

分支状态来自本地缓存；只有用户显式刷新远程时 fetch，并记录获取时间。切换、创建、删除、合并、恢复和远程写操作由服务验证目录权限、分支/HEAD、审阅快照、进行中的 Git 操作及活动任务，不信任客户端传入的任意 cwd 或参数。被其它 Worktree 检出的分支提供定位入口。

Pull 检查真实远程和本地状态并只允许快进，不自动 stash、rebase 或强制覆盖。Push 指定目标远程与分支，保留 hooks，关闭 mirror、强制推送、自动标签及递归子模块推送；非快进由 Git 拒绝。

普通合并发生冲突时自动中止；合并到未检出目标可使用临时 Worktree。三栏文本冲突预览及解决接口尚未实现，继续由[冲突解决计划](../plans/git-merge-conflict-resolution.md)管理，不能写成现行能力。共享任务仅获得任务限定的 Git 能力，不能使用宿主全局设置和任意仓库写操作。

前端重复读取由 Git store/API 合并；页面隐藏时暂停状态轮询，操作后及恢复可见时统一刷新。实现入口为 `api/git.py`、`services/git/` 和 Web `components/git/`；职责及测试详见[Code Map](code-map.md)。关键回归包括 daemon `test_git_api.py`、`test_remote_git.py`，Web `gitPanelWrites.integration.test.tsx`、`gitDiffDialog.test.tsx`、`gitBranchPicker.test.tsx`、`gitWorkspaceScope.test.ts`。

## 新手引导

`OnboardingChecklist` 与工作区引导动作复用已有表单，引导按真实资源状态推进：供应商、兼容引擎、项目、示例流程和首个任务。状态存于 `workstep:onboarding:v1`，重新打开时核验资源，资源删除后回退；首任务创建即完成，不自动运行或调用模型。升级用户不自动弹出，引导可跳过、收起和从设置 → 系统设置 → 新手引导重新打开；入口和测试见[Code Map](code-map.md)。

## 环境与验证

```bash
cd apps/daemon
uv sync --dev
uv run --no-sync pytest
```

```bash
cd apps/web
corepack yarn install --frozen-lockfile
corepack yarn test
corepack yarn build
```

前端 `yarn test` 默认最多并发运行 2 个测试文件，避免测试进程同时编译 TypeScript、加载 DOM 和组件依赖时挤占桌面资源。仅验证局部改动时，在 `apps/web` 使用 `rtk proxy yarn node --no-experimental-global-navigator --loader ./scripts/test-loader.mjs --test --test-concurrency=2 tests/<文件名>.test.tsx` 运行对应测试。直接调用 `node --test` 不会继承 `package.json` 中的并发限制，必须显式指定 `--test-concurrency=2`。本机各应用的全量测试依次执行；多个聊天同时工作时也不要重叠启动全量测试。RTK 只过滤命令输出，不限制 CPU 或内存。

前端测试遵守 [Web 开发指导中的 DOM 断言规则](../apps/web/AGENTS.md#前端开发规范appsweb)，将元素存在性、节点身份、文本、属性或数量转换为布尔值或简单值后再断言。DOM 数组应映射为简单值后比较，保留数量、顺序和身份检查。Web 与 Gateway Web 的 `yarn test` 先运行 `scripts/check-dom-assertions.cjs`，拦截直接接收 DOM 对象或数组的 Node 等值断言；局部测试可先在应用目录运行 `rtk proxy node ../../scripts/check-dom-assertions.cjs .`。

官网在 `apps/landing`，也使用 Yarn。仓库检查可运行 `python scripts/check_repository_health.py`。行为变更先写失败回归，再实现和验证；跨层变更还需运行相关 API、组件和端到端检查。不要提交构建产物、数据库、日志、密钥或个人配置。

本机 RTK 0.47.0 在仅向包装器发送 SIGTERM 后可能遗留 Node 测试主进程及其子进程，`rtk proxy` 也不能保证回收整棵进程树。Node/Yarn 测试统一使用 `rtk proxy node` / `rtk proxy yarn`，避免未知命令回退路径；停止测试时须核对并终止本次运行的进程组及残留子进程。断言失败时展开 DOM 对象造成的内存增长发生在 Node 内部，与是否使用 RTK 无关，切换包装器不能修复。

从设置页安装的可选引擎 SDK 位于 `~/.workstep/runtime/python-packages`（或 `WORKSTEP_ENGINE_PACKAGE_DIR`），不在 uv 管理的环境和 `uv.lock` 中；daemon 启动时将该目录加入导入路径。重新同步锁定依赖可运行 `uv sync --dev`，所选 SDK 版本不会因此被覆盖。

外部贡献流程见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

## 用户操作手册

操作手册同步只在 `dev` 合并到本地 `main` 并提交本批代码时触发，集中整理本批已通过行为测试的用户可见功能；日常开发不逐功能更新手册和截图。手册变更随本批交付一起提交。统一维护官网的 [操作手册内容](../apps/landing/src/manual/)。每个纳入手册的功能包含用途、界面入口、操作步骤、输入示例、预期结果、排错说明及真实截图（范围与免截图项见[手册规则](../apps/landing/AGENTS.md)）；操作或界面变化时同时修改文字和图片，删除功能时移除失效说明。SDK 是首次接入推荐路径，CLI 保留为其他接入方式。

截图统一复用本机 `8777` 端口的“操作手册演示”项目，启动和目录约定见 [演示环境](manual-demo.md)，禁止包含密钥、个人会话、内部服务地址及私有项目内容。截图声明和图片文件通过 `yarn --cwd apps/landing manual:check` 核对；缺口必须明确登记，不能把示意图当成真实截图。合并提交节点运行官网测试与构建，人工核对桌面、手机端章节导航和图片可读性。详见[官网与手册规则](../apps/landing/AGENTS.md)。

## 应用版本号

桌面端与 daemon 使用同一应用版本，发布版本来源为 `apps/desktop/package.json` 的 `version`。升版本使用 `npm version <版本号> --no-git-tag-version`（在 `apps/desktop` 执行），其 `postversion` 自动同步 daemon 的 `pyproject.toml` 和 `uv.lock`；手动修改版本后执行 `node scripts/sync-app-version.cjs`。

源码 daemon 从桌面端 manifest 读取版本；独立 daemon 目录使用自身 `pyproject.toml`。桌面后端打包时写入 `app/daemon/app-version.json`，版本来自 `WORKSTEP_BUILD_VERSION` 或桌面 manifest。启动器可通过 `WORKSTEP_VERSION` 覆盖运行时版本，网关心跳使用同一运行时值。不得按网关最新发布版本推断本地运行版本。

WebSocket 主事件流和分享事件流通过 `streaming/ws.py::_wait_for_stream_input` 等待事件／客户端输入，无论哪一方完成、断开或父任务取消，都取消并等待其余子任务结束，避免遗留接收任务在垃圾回收时跨上下文释放追踪 token。回归为 `test_main.py` 的取消／同时断开测试。Gateway 下发供应商端点与平台 `ProviderInput` 的契约一致，允许 HTTP／HTTPS，拒绝账号密码、片段和超过 2048 字符的地址；签名、作用域、版本与加密验证保持原流程，签名配置应用回归为 `test_gateway_provider_config.py`。
