# 两个后端的三层架构与异步 I/O 检查

检查日期：2026-10-04。基于本地 main 创建分支 `codex/backend-layering-async-audit-20261004`；检查对象是 `apps/daemon` 和 `apps/gateway`。下述检查结论记录优化前状态；后续修改与验证见文末。

## 结论

| 项目 | 三层职责 | 数据库异步隔离 | 已确认的阻塞问题 |
| --- | --- | --- | --- |
| daemon | 有 API / services / models，但接口层仍拥有数据库操作和业务逻辑，存在服务反向依赖接口 | 项目 Peewee 通过专用线程串行执行，已检查路径的慢 SQL canary 通过 | 协调助手流式回调同步写事件日志；DeepSeek Harness 启动同步解析磁盘路径 |
| Gateway | 有 API / services / models，路由层较薄；服务层仍混合 HTTP 适配职责 | 使用 AsyncSession + aiosqlite / asyncpg；SQLite 锁竞争健康检查通过 | 本次检查未确认数据库阻塞事件循环的问题 |

“所有 I/O 异步”应以事件循环是否被阻塞判断。daemon 的同步 Peewee 可以保留，但完整数据库工作单元必须经过 `project_manager.run_db`，包含查询物化、事务与序列化；仅把函数声明为 async 不够。

## 发现与优先级

### P1：协调助手的流式日志写入绕过异步日志接口

- `apps/daemon/agent_assistants/coordinator.py:776`：异步 `publish_live_event` 直接调用 `self._event_journal.record(...)`。
- `apps/daemon/agent_assistants/event_journal.py:199`：`record` 同步调用 `resolve`，涉及文件系统路径解析；强制刷新、缓冲超过 32 KiB 或超过刷新间隔时同步调用 `sync`。
- `event_journal.py:235`：`sync` 执行文件打开、写入、flush；durable 时执行 `os.fsync`。`session_started` 和 `interaction_request` 会触发强制刷新。
- `event_journal.py:256`：同步调用 record 在事件循环内登记的定时回调 `_flush_scheduled` 也直接调用同步 sync，因此普通流式事件的定时刷新也存在阻塞。
- 已有 `arecord` 和 `async_flush` 隔离到专用日志线程，调用方没有统一使用。

验证：在临时目录创建真实日志，复用该回调的 `record(force=True)` 调用方式，把同步 sync 延迟 250 ms；同时运行 10 ms 的轻量协程，实际延迟约 **255 ms**。这是调用方式的最小复现，不是完整协调助手 API 集成测试。

建议：流式回调改为 `await arecord(...)`，统一日志状态在线程中的访问；增加真实协调助手流式事件测试，覆盖普通缓冲、强制刷新、定时刷新及健康检查。现有 `test_event_journal.py` 仅证明异步日志接口可隔离 I/O，不能保证调用方使用了异步接口。

### P2：DeepSeek Harness 启动仍在事件循环解析磁盘路径

`apps/daemon/engines/deepseek_harness.py:804` 的 async spawn 直接执行 `Path(cwd).expanduser().resolve()`。resolve 会访问文件系统；慢盘或网络挂载目录可能拖住事件循环。

建议：在线程中解析项目路径，并以慢路径解析 + 并发轻量协程验证。此项由代码确认调用位置，未运行该引擎的集成复现。

### P2：daemon 三层边界没有完全落实

- `apps/daemon/services/task_dispatch.py:181` 的 `_dispatch_remote` 从 `api.remote_project` 获取 `client_manager`，是服务层反向依赖接口层。建议由装配层注入远程项目客户端。
- AST 导入检查发现 daemon 有 **12 个接口模块**导入 models（包含函数内部导入）；如 `api/task_archive.py:82` 的 `_archive_draft_message` 自行查 Task / Message 并进行归档草稿范围校验。
- 上述数据库辅助函数即使经 `_run_db` 执行而不阻塞，职责仍属于服务层，不能因此认定三层边界合格。

建议：将归档草稿校验、持久化等完整工作单元移到对应服务；路由保留请求解析、调用服务与响应映射，并将行为测试放在实际职责所有者。

### P2：Gateway 有三层目录，但服务层仍耦合 HTTP

- API 层没有直接导入 Gateway models，路由通常只是调用 services 对应处理函数。
- **31 个服务模块**导入 FastAPI；例如 `services/identity_api.py:118` 设置 Cookie，`:125` 校验 HTTP CSRF，`:296` 的用户列表从 Request 获取数据库并直接进行查询。
- `services/identity.py` 的核心身份服务也直接抛出 HTTPException。
- `tests/test_layering.py` 只检查三层目录存在、服务不导入 `gateway.api`；不检查上述 HTTP 耦合，测试通过不能证明严格的三层职责成立。

若“三层”仅要求目录与依赖方向，Gateway 基本符合；若要求接口适配与业务处理独立，目前只能算部分符合。建议接口适配层持有 Request / Response / Cookie / HTTPException，核心服务接受业务参数并返回结果或领域错误。

### P3：项目数据库异步上下文入口存在误用隐患

`apps/daemon/services/project.py:170` 的 `ProjectContext.__aenter__` 直接调用同步 `__enter__`，后者可能同步建立数据库连接。异步上下文不构成数据库隔离，还可能让数据库激活上下文跨越 await。

本次没有找到生产代码使用该 async context 的调用点，因此列为潜在入口风险，不列为已发生的数据库阻塞。建议取消这种入口或明确拒绝事件循环使用，统一走 run_db。

## 验证结果

未启动项目常驻进程；测试使用已有虚拟环境和本地测试数据库，未同步依赖。

- Gateway：`test_layering.py`、`test_database.py`、`test_external_identity_canary.py`，**16 passed / 1 skipped**。包括 SQLite 写锁竞争、慢备份、慢身份供应商与健康检查；PostgreSQL 专用检查未覆盖本次环境。
- daemon：`test_project_audit.py`、`test_project_audit_task_crud.py`、`test_api_contracts.py` 中按 `nonblocking / slow / responsive / executor / keeps_health / archive_experience` 筛选，**27 passed / 110 deselected**。
- daemon：`test_recovery.py`、`test_workflow_lease.py`、`test_workflow_runtime.py`、`test_event_journal.py`、`test_gateway_project_publication.py` 中按 `slow / responsive / async / heartbeat / block` 筛选，**71 passed / 1 failed / 10 deselected**。
- 失败为 `test_workflow_runtime.py::test_runtime_executes_saved_canvas_workflow[asyncio]`：预期 3 条 TEXT_MESSAGE_START，实际 5 条；单独重跑仍失败。没有修改业务代码，尚未确认是测试断言过时还是业务事件重复，不能据此判断数据库阻塞。

检查包含目录依赖、异步函数直接 I/O、部分同步辅助函数调用链和现有 canary；没有运行全部后端测试，也不构成所有引擎、所有生产调用路径无阻塞的保证。当前证据支持“数据库隔离主路径有效，但异步 I/O 仍有明确漏口”，不能给出两个后端全部合格的结论。

## 后续优化

- 已修复协调助手同步日志调用，并补齐异步日志接口的静默尾部定时刷新；定时器只管理调度，磁盘操作在专用线程中执行。新增真实协调 API 慢盘健康检查，覆盖强制刷新和大事件缓冲刷新。
- 并发回归复现日志刷新期间项目数据库线程追加事件会被清空缓冲丢失；日志完整存储工作单元增加可重入锁，保护序号、缓冲和文件写入。锁等待位于工作线程。
- DeepSeek 项目路径解析已进入工作线程；ProjectContext 拒绝异步激活，提示使用 run_db。
- 远程客户端从 main 装配层注入派发服务，移除 services → api 反向依赖；归档草稿及记忆写入工作单元迁移到 services/task_archive.py，原有慢数据库校验测试改为作用于服务。
- Gateway 核心身份服务已改用与 HTTP 框架无关的 IdentityError；接口边界保持原状态码和错误结构。注册、登录、管理权限、扫码回调、远程 WebSocket 和审计的异常处理同步适配。
- 增加分层守护及错误映射测试，并同步 docs/code-map.md。首次优化保留的历史接口数据库职责和 Gateway HTTP 耦合，已在下述完成阶段继续迁移。

首次优化验证：Gateway 全量 **220 passed / 1 skipped**；daemon 相关模块与 API 回归 **246 passed**（包含日志并发修复）。

后续确认工作流事件数量失败来自过时断言：两条步骤消息各自的提示词更新复用 TEXT_MESSAGE_START，共 5 条事件，但只有 3 个消息 ID 和 3 条数据库消息。按用户要求删除 `test_runtime_executes_saved_canvas_workflow`；该文件其余测试 **47 passed**。


## 完成剩余分层治理

- daemon 全部 API 模块不再导入 ORM 模型；任务、审核、分享、会话存在性查询与序列化归 `services/task_queries.py`，跨项目搜索和历史归 `services/task_search.py`，派发准备归 `services/task_dispatch.py`。同步工作单元仍通过项目数据库执行器提交，跨项目查询按项目并发等待。
- daemon 的桌面安全与浏览器身份/访问中间件归 `api/desktop_security.py`、`api/remote_access_guard.py`，远程 HTTP 代理归 `api/remote_project_proxy.py`，FastAPI 路由目录与远程 socket 适配归 `streaming/remote_host.py`。服务中的项目访问策略接受普通参数，接口包装负责权限错误映射。
- Gateway 所有服务不再导入 FastAPI/Starlette 或访问 ASGI 应用。`contracts.py` 定义输入、依赖及异步端口，`api/adapters.py` 负责输入构造、Cookie、响应、文件和 WebSocket 框架适配。服务返回业务错误和数据/流式结果，数据库仍使用原生异步会话。
- HTTP 失败审计提取与 SQL 持久化分开；静态分享资源移入 Gateway API 层。两端守护测试覆盖全部模块的依赖方向，禁止 API 直接导入模型和服务依赖 HTTP 框架。
- 新增 daemon 搜索、历史与审核的真实 API 慢 SQL 健康检查；Gateway 新增普通输入、异步正文、延迟流消费、重复响应头、Cookie 属性与业务错误映射兼容测试。

本阶段验证：

- Gateway 最新全量 **232 passed / 1 skipped**。跳过项仍是未配置 `WORKSTEP_TEST_POSTGRES_URL` 的 PostgreSQL 集成测试。
- daemon 分层、慢 SQL canary、项目执行器与生命周期回归 **54 passed**；完整 API 合同 **128 passed**；远程项目、桌面安全、任务、分享与 Action 回归 **146 passed**；受管项目任务/归档/会话、Git 与远程 Git 回归 **137 passed**。这些批次有重叠，不应相加当作独立测试总数。
- daemon 全量检查记录 **2288 passed / 42 failed**。其中生命周期测试的旧构造器桩遗漏参数已适配并单独验证通过。其余失败包括共享 `/tmp/.agents/skills/workstep-cli` 目录不属于 WorkStep（25 项及其下游超时）、缺少 Qoder SDK（8 项），以及既有聊天时序、消息事件、助手提示词断言；不能宣称整个 daemon 测试套件全绿。
- 使用 `git archive HEAD` 在独立临时目录运行原分支全量检查，**2302 passed / 13 failed / 2 skipped**：复现 Qoder SDK 缺失、队列停止时序、步骤插入消息事件断言、生命周期旧构造器桩、助手提示词断言和原工作流事件数量断言。快照与工作目录的技能来源路径不同；将快照测试进程的内置技能来源对齐工作目录后，同样的 **30 项 Codex 失败**在原分支复现，失败用例集合完全一致，包含共享 `/tmp` 目录冲突及下游超时。相关 Codex 引擎与技能运行时源码均与 HEAD 相同。除已修复的生命周期测试桩外，本轮全量失败均在原分支及同等技能来源条件下复现；不表示旧测试与环境问题已解决。原分支快照不覆盖或恢复本地修改。

PostgreSQL 专用集成测试保留；已按用户指示删除的旧工作流测试为 `test_runtime_executes_saved_canvas_workflow`。当时未删除其余失败测试。


用户随后明确要求删除两条旧测试：`test_concurrency_gate.py::test_stopping_queued_chat_persists_stopped_message`（停止完成后仍从内部任务表读取已清理协程）和 `test_live_step_message.py::test_runner_splits_step_message_on_live_insert`（将开始事件数量等同于消息数量）。已删除这两条用例，以及仅供后一用例使用的 `SplitLiveFakeEngine`；其余测试保留。删除后的验证结果另行记录，不复用此前全量测试数量。

删除后验证：`uv run --no-sync pytest tests/test_concurrency_gate.py tests/test_live_step_message.py -q --tb=short --timeout=30`，**31 passed**；`git diff --check` 通过。

用户进一步要求删除 `test_workstep_tools_injection.py::test_assemble_context_never_injects_workstep_docs_even_when_capable`：该用例把通用角色说明中的 `WorkStep internal tools` 字样当成工具文档注入。已删除，文件其余测试 **13 passed**，`git diff --check` 通过。

## 合并前测试环境修正

- 安装仓库已声明的可选 Qoder 依赖组：`uv sync --frozen --dev --group qoder`，未修改依赖声明或锁文件。
- Codex CLI/SDK 的测试及共用参数收集辅助函数改用 pytest `tmp_path`，避免共享 `/tmp/.agents/skills` 与已有非受管目录冲突；保留事件、审批、恢复、压缩、参数及超长行断言，生产目录保护逻辑未改动。
- 生命周期测试恢复其直接赋值的服务全局变量与 Gateway 客户端的运行时引用，避免残留 `BotStub` 污染后续任务归档测试。生命周期和归档按顺序验证 **19 passed**；参数辅助函数涉及的三条用例 **3 passed**。

最终合并前完整验证：daemon `uv run --no-sync pytest -q --tb=short --timeout=60`，**2327 passed / 0 failed**（251.75 秒）；Gateway `uv run --no-sync pytest -q --tb=short`，**232 passed / 1 skipped / 0 failed**（44.17 秒）。Gateway 唯一跳过项仍为未配置 `WORKSTEP_TEST_POSTGRES_URL` 的 PostgreSQL 集成测试。两端输出仅余依赖弃用警告；`git diff --check` 通过。
