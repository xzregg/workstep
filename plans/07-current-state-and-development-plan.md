# WorkStep 现状审计与后续开发计划

> 审计日期：2026-07-27  
> 审计范围：`apps/daemon/`、`apps/web/`、`docs/`、`plans/`、启动脚本与自动化测试  
> 目标：以“用户能从画布定义工作流，并由真实 LLM 完整执行、产出、回放”为完成标准，重新判断项目状态并安排后续开发。

## 0. 2026-07-27 实施与验收更新

本轮已完成一次覆盖现有公开功能的自动化、浏览器和真实引擎验收：

- 后端：`175 passed`，无 warning。
- 前端：TypeScript/Vite production build 通过，Oxlint 零 warning。
- 浏览器：项目选择、任务看板、任务新建（含 description）、详情历史、删除、画布加载与保存均通过。
- 真实 LLM：Claude 生产 adapter 调用通过；一阶段 `WorkflowRuntime → TaskRunner → Engine → EventBus → SQLite` 全链路通过，持久化文本为 `WORKSTEP_WORKFLOW_OK`。
- 引擎发现：新增 `/api/engine/list`；ACP 只在真实 bridge 存在时启用；坏掉的 Codex PATH shim 和未配置密钥的 API engine 不再误报可用。
- ACP：修正到当前 Python ACP SDK 的 `spawn_agent_process`/client callback 协议；Qoder 已能连接服务，但账号返回计费 `FORBIDDEN`。
- Hermes：改用标准 ACP SDK，协议链路已通；当前账号返回 token-plan quota exhausted。
- 项目/API：修复 register 缺少 `id`、sessions 串库、跨项目搜索及分页总数、step history 串库、pause 未停止活动 runtime。
- 前端：修复重复 WebSocket 连接、StrictMode 重连泄漏、删除只改本地状态、描述未提交、状态徽标伪造、画布旧无效端口导致永远无法保存。
- 安全/边界：模板 ID 防目录穿越并校验工作流；文件预览增加 1 MiB 上限；API engine 无凭证时默认不可用。

当前尚不能宣称“产品所有规划功能完成”。本轮证明了现有公开主链路可运行；剩余产品级工作仍包括事件增量持久化与重启恢复、产物登记/版本、后端持久化泳道投影、WebSocket project/run 隔离、完整 intervention UI，以及外部 Qoder/Hermes 账号额度恢复后的成功响应复验。

## 1. 结论

WorkStep 已经具备一套可继续开发的原型骨架：

- FastAPI Daemon、React 前端和 per-project SQLite 已落地。
- Claude、Codex、Hermes 等引擎已有统一抽象和事件映射。
- 画布、任务看板、详情页、WebSocket、DAG 调度器均有实现。
- 后端测试和前端构建目前可通过。

首次审计确认它还不是“多阶段 LLM 工作流可用产品”。本轮已完成第一批主链路改造：

1. 新增 `WorkflowDefinition`，统一校验并编译画布 `{nodes, connections}` 和旧 `{steps, dependsOn}`。
2. 新增 `WorkflowRuntime`，生产 `/api/task/run` 已进入 DAG `TaskRunner`，并支持取消。
3. 新增 schema migration、`workflow_runs` 和 `step_runs`，运行会保存工作流快照和阶段 attempt。
4. 修正 error/cancel 的一致状态收尾，并阻止失败节点的下游继续执行。
5. 修复内置研发模板的无效端口和缺失依赖，所有内置模板均可编译。
6. 新增 task-local `ProjectContext`，并发协程不会因另一个项目绑定而串库。
7. `WorkflowRuntime` 统一托管后台任务，启动返回 `run_id`，Daemon 关闭前停止引擎并等待收尾。
8. 创建和复制任务会按工作流生成全新的 pending 阶段；新 WorkflowRun 不会复用上次成功状态。

仍需优先解决的产品级断点是：前端状态事实源分裂、消息/事件增量持久化、Daemon 重启恢复、产物闭环，以及“HTTP → WebSocket → 数据库 → 历史回放”的完整端到端验证。

因此，现有 `06-build-order.md` 中 P1–P4 的“已完成”应理解为“模块骨架或局部测试已完成”，不能作为产品完成度依据。下一阶段应优先打通一条真实纵向链路，暂缓继续扩展更多引擎和外围功能。

## 2. 本次验证基线

### 2.1 自动验证结果

| 验证项 | 结果 | 备注 |
|---|---:|---|
| 后端 `pytest` | 175 passed | 首轮审计为 119；当前无 warning |
| 前端 TypeScript + Vite 构建 | 通过 | 产物约 470 KB，未做拆包 |
| 前端 Oxlint | 通过 | 零 warning |
| 真实 Claude 调用 | 通过 | engine smoke 与完整 workflow smoke 均通过 |
| 真实 Codex 调用 | 不可用 | PATH shim 指向缺失的 native binary，现已正确标记 unavailable |
| 真实 Hermes/Qoder 调用 | 外部阻塞 | 协议已通；分别为额度耗尽与计费 FORBIDDEN |
| 多阶段管道 HTTP 集成 | 部分覆盖 | 已覆盖 HTTP 委托、画布编译和运行持久化；尚缺 WebSocket/产物/回放全链路 |
| 多项目并发隔离 | 基础覆盖 | ContextVar 交错协程读写测试通过；仍需生产 Runtime 压力测试 |

### 2.2 工作树说明

审计时仓库存在未提交修改与新增文件，涉及 P5 引擎、搜索、模板、产物预览、卡片操作等。本文将这些实现标记为“在建/实验性”，不把“文件存在”直接等同为“生产完成”。

## 3. 设计评估

### 3.1 当前模块关系

```text
React 页面
  ├─ projectStore ── REST ── ProjectManager ── db_proxy ── project SQLite
  ├─ taskStore    ── REST ── TaskService ───── Engine Registry ── LLM CLI
  └─ useWebSocket ◀───────── EventBus ◀──────── TaskService / TaskRunner

CanvasEditor ──保存校验──> WorkflowDefinition ({nodes, connections})
                              │ compile
                              ▼
/api/task/run ──> WorkflowRuntime ──> CompiledWorkflow ──> TaskRunner
                         ├─ WorkflowRun/StepRun
                         └─ EventBus
```

本轮已接上原先断开的定义 seam 和运行 seam。下一批最关键的 seam 是：

- **事件/持久化 seam**：运行中的事件尚未以可重放的 sequence 增量持久化。
- **前端事实源 seam**：看板本地泳道状态仍未完全由后端 run/step 状态投影。
- **恢复 seam**：进程重启后尚不能把残留 running 状态归档为 interrupted 并恢复事件。

### 3.2 建议的目标模块

建立一个深模块 `WorkflowRuntime`，让 REST、WebSocket 命令和测试都只依赖同一个小接口：

```python
handle = await workflow_runtime.start(
    project_id=project_id,
    task_id=task_id,
    user_input=user_input,
)

await workflow_runtime.cancel(handle.run_id)
await workflow_runtime.retry_step(handle.run_id, step_key)
```

该模块内部隐藏：

- 项目数据库上下文；
- 工作流定义加载、校验和编译；
- DAG 调度与并发；
- Prompt 组装；
- 引擎选择、执行和取消；
- 状态机；
- 事件持久化与广播；
- 产物发现和登记；
- 会话恢复与重试。

其他建议模块：

| 模块 | 小接口 | 隐藏的实现复杂度 |
|---|---|---|
| `WorkflowDefinition` | `load / validate / compile` | JSON schema、画布连线、条件、版本、兼容迁移 |
| `ProjectContext` | `open(project_id)` | DB 连接、路径范围、配置和项目隔离 |
| `EngineAdapter` | `run(request) -> events`、`stop()` | CLI/ACP/API 协议差异、stderr、退出码、session |
| `RunRecorder` | `start / append / finish` | messages、events、usage、运行恢复、批量落库 |
| `ArtifactCatalog` | `discover / list / version` | 文件扫描、hash、版本、预览权限、上游输入 |
| `EventStream` | `publish / subscribe / replay` | project/run 作用域、sequence、断线补发、背压 |

### 3.3 统一工作流定义

当前至少存在四份默认定义：

- `services/project.py::DEFAULT_STEPS`
- `apps/daemon/data/steps.json`
- `CanvasEditor.tsx::DEFAULT_NODES`
- `api/templates.py::BUILTIN_TEMPLATES`

它们已经出现连接关系不一致，应收敛为一个版本化 schema 和一个默认模板来源。

推荐持久化格式：

```json
{
  "schemaVersion": 1,
  "nodes": [
    {
      "id": "node-uuid",
      "key": "frontend",
      "label": "前端开发",
      "position": {"x": 640, "y": 120},
      "engine": "claude",
      "model": "",
      "prompt": "...",
      "inputs": [],
      "outputs": []
    }
  ],
  "edges": [
    {
      "id": "edge-uuid",
      "source": {"nodeId": "node-uuid", "port": "output-id"},
      "target": {"nodeId": "node-uuid-2", "port": "input-id"},
      "condition": null
    }
  ]
}
```

执行前由 `WorkflowDefinition.compile()` 生成只读的 `CompiledWorkflow`，计算 `depends_on`、fan-out、join 和输入映射。UI 和调度器不再各自解释 JSON。

PRD 同时要求“DAG”与“条件回到需求阶段”，两者互相冲突。v1 建议继续严格禁止环；“返工”通过对已完成阶段创建新 attempt、重置下游状态实现，而不是在图中创建循环边。

## 4. 完成度矩阵

状态含义：

- **可用**：生产入口已接通，具有与风险匹配的验证。
- **部分**：有实现，但缺少关键链路、状态或验证。
- **骨架**：只有接口、占位实现或导入测试。
- **缺失**：目标能力尚未实现。

| 领域 | 当前状态 | 已有内容 | 主要缺口 |
|---|---|---|---|
| 项目初始化/注册 | 部分 | `.workstep`、SQLite、项目列表、幂等迁移 | register 响应缺 `id`；配置错误处理不足 |
| 多项目隔离 | 部分 | 每项目 SQLite、ContextVar 数据库路由、`ProjectContext` 作用域恢复 | 缺生产 Runtime 并发压力测试和 repository 层 |
| 画布编辑 | 部分 | 节点增删、连线、保存校验、自动布局 | 无条件编辑；保存后前端项目状态可能陈旧 |
| 工作流模板 | 部分 | 内置模板、后端路由、编译测试 | 前端未使用；仍有多份默认定义 |
| DAG 调度 | 部分 | 生产入口已支持画布编译、拓扑、fan-out/join 和后台任务托管 | 缺 WebSocket/产物/回放完整 E2E |
| 条件路由 | 骨架 | 字符串条件求值 | `TaskRunner` 未传 `step_results`；失败分支不能运行；UI 无编辑能力 |
| 任务创建/列表 | 部分 | REST、SQLite、看板；按工作流初始化 TaskStep | description 未从前端提交；前端阶段投影仍不完整 |
| 卡片阶段进度 | 骨架 | `TaskStep` 表存在 | 看板泳道和状态主要为前端本地状态，刷新即丢 |
| 卡片暂停 | 骨架 | 修改 task.status | 不暂停子进程，不阻止调度继续 |
| 卡片取消 | 部分 | runtime 定位活动 runner、调用 engine.stop 并一致收尾 | 重启后运行归属与恢复尚未实现 |
| 删除/复制 | 部分 | 后端复制会重建 pending 阶段，store 在建 | 看板删除仍为 TODO；UI/DB 一致性未验收 |
| 工作流运行入口 | 部分 | `/api/task/run` 返回 run_id；`WorkflowRuntime` 托管、等待、取消和关闭 | 缺完整 HTTP/WS E2E |
| 运行状态机 | 部分 | task/step/workflow run/step run 状态；error/cancel 一致收尾 | `ready` 仍同时表示未开始和完成；状态枚举尚未冻结 |
| Claude CLI | 部分 | spawn、JSONL 映射、resume 参数 | session 未持久化；stderr 潜在阻塞；一次消息多 block 可能丢失 |
| Codex CLI | 部分 | spawn、JSONL、sandbox | 无真实验收；Windows 高权限无用户确认 |
| Hermes | 部分 | JSON-RPC、自动权限处理 | 生命周期、进程退出和真实协议未做集成验证 |
| ACP 引擎 | 骨架/部分 | 公共基类和三个 adapter | 进程句柄未正确持有，stop/inject 不能证明有效；session 未落库 |
| QCode/OpenClaw | 骨架 | CLI 探测、占位命令、假定 JSONL | 协议明确标注为 placeholder，不应暴露为稳定引擎 |
| API 直调 | 骨架 | OpenAI/Anthropic 请求代码 | “流式”先缓冲完再返回；SSRF/密钥/HTTP 错误处理不完整；`httpx` 仅 dev 依赖 |
| 引擎发现 | 部分 | registry 可探测 | 缺 `/api/engine/list` 路由，前端 client 调用会 404 |
| 实时事件 | 部分 | EventBus + WebSocket | 全局广播无 project/run 隔离；无 sequence/replay；队列满直接移除订阅者 |
| 前端 WebSocket | 部分 | 重连和 Zustand 消费 | Layout 与 TaskDetail 重复连接；运行后清空状态存在首事件竞态 |
| 事件展示 | 部分 | 文本和部分工具事件 | 多阶段输出按 task 混合；无 run/step 归组；无完整 intervention UI |
| 消息持久化 | 部分 | assistant content/events 最终落库 | user message 不落库；position 固定；运行中不增量写，崩溃会丢 |
| 历史回放 | 部分 | history 查询和事件 generator | 重复路由；排序不一致；前端没有真正的事件时间轴回放 |
| 会话恢复 | 未完成 | 引擎参数支持 | 无 `agent_sessions` 表和 session 生命周期 |
| 产物输出目录 | 部分 | Prompt 指示目录、下游扫文件 | 无完成校验；没有产物登记 |
| 产物模型/版本 | 未完成 | PRD 和测试名称提及 | 没有 `Artifact` 模型、hash、版本或 produced_files |
| 产物预览 | 骨架 | `ArtifactPreview` 和任意文件 preview 路由 | 组件未接页面；无 artifact list；路径没有限制在项目内 |
| 搜索/会话列表 | 骨架 | 后端路由和 client | UI 未接；sessions 按 `Task.id == project_id` 查询错误；跨项目查询不可靠 |
| Schema 迁移 | 已完成（当前版本） | schema version、v1–v3 幂等迁移和旧库升级测试 | 后续模型变更需持续追加 migration |
| 安全 | 部分 | Codex 默认 workspace-write | 文件预览路径过宽；API Base SSRF 未限制；凭证剥离未实现 |
| 可观测性 | 骨架 | Python logging、usage 事件 | 无 run 日志、duration/cost、指标、原始事件文件或 Langfuse |
| 发布/恢复 | 部分 | start/stop/restart 脚本；关闭会停止并等待活动运行 | Daemon 异常退出后不恢复或清理 running 状态 |
| 文档一致性 | 未完成 | PRD 和多份计划较丰富 | 仍混用 Open Design/WorkStep、TS/Python、SSE/WebSocket、旧路径 |

## 5. P0 风险

以下问题应在增加新功能前解决。

### 5.1 多项目串库（本轮已解决异步绑定问题）

此前 `models.base.db_proxy` 是进程级可变对象。HTTP 请求先绑定项目 A 并创建后台任务后，另一个请求可把 proxy 切换到项目 B；后台任务后续 ORM 操作可能落到 B。

处理原则：

- 运行实例必须持有不可变的 `ProjectContext`。
- Repository 操作必须显式使用该项目数据库。
- 禁止后台任务依赖“当前绑定项目”这种全局状态。
- 增加两个项目同时运行和交错查询的压力测试。

当前 `ProjectDatabaseProxy` 使用 `ContextVar` 选择数据库，`WorkflowRuntime.start()` 在 `ProjectContext` 中创建后台任务；交错协程读写及作用域恢复测试均已通过。完整生产 Runtime 并发压力测试仍保留在 R2 验收项。

### 5.2 错误事件被判成功（本轮已解决）

引擎经常通过 yield `InternalEvent(type="error")` 报错，而不是抛异常。此前 `TaskService` 和 `TaskRunner` 只在捕获异常时失败，因此可能把“binary not found”或非零退出事件标记为 passed。

运行完成必须返回明确结果：

```python
RunOutcome(status="succeeded" | "failed" | "cancelled", error=None)
```

不能通过“async iterator 正常结束”推断成功。

当前实现已将 `error` 事件转换为失败结果，完成 task/step/run/message 收尾并阻塞下游；回归测试覆盖 `TaskService` 和 `TaskRunner` 两条路径。

### 5.3 工作流 schema 不兼容（本轮已解决）

画布定义与执行定义不一致，意味着即使把 API 改接 `TaskRunner`，也不能正确获得依赖关系。必须先完成 schema 统一/编译器，再切换生产入口。

当前实现由 `WorkflowDefinition` 负责加载、校验和编译两种格式，保存接口会拒绝非法图，生产运行入口只消费编译结果。

### 5.4 状态事实源分裂

看板通过本地 `cardLanes`、`cardStatuses` 模拟状态，详情页又使用后端 task.status。用户看到的泳道、状态和真实任务执行可能互相矛盾。

后端投影 `Task + TaskStep + active runs` 必须成为唯一事实源，前端只做乐观展示。

### 5.5 文件与网络安全

- `/api/fs/preview` 可读取任意绝对路径。
- API engine 的 `API_BASE` 未执行 PRD 约定的 loopback/allowlist 检查。
- Windows Codex `danger-full-access` 没有显式确认流程。
- Claude 凭证剥离策略未实现。

这些能力在产品化之前必须默认安全失败。

## 6. 分阶段开发计划

估时为单人净开发时间，包含实现、自动化测试和文档更新，不包含外部 CLI 协议调研等待时间。

### R0：冻结契约与建立迁移能力（3–5 人日）

**目标**：先统一系统语言和事实源，使后续改造不会继续增加兼容层。

任务：

- [x] 定义 `WorkflowDefinition v1` 及版本校验。
- [x] 实现 `load / validate / compile`，把 nodes/edges 编译为 `CompiledWorkflow`。
- [x] 为旧 `{steps, dependsOn}` 和当前 `{nodes, connections}` 提供兼容 adapter。
- [ ] 删除四份默认工作流定义，保留一个内置模板源。
- [ ] 明确 task、workflow run、step run、message、artifact 的状态机。
- [x] 引入 SQLite schema version 和幂等迁移器；旧三表数据库可无损升级。
- [ ] 更新 PRD 中 Python/WebSocket/实际目录等已确定决策。

验收：

- Canvas 保存的文件能直接通过后端校验和编译。
- 非法端口、缺失节点、重复 key、环路都返回可定位错误。
- 新旧示例工作流迁移后得到相同 DAG。
- 已存在项目数据库能无损升级。

### R1：打通真实管道纵向切片（5–8 人日）

**目标**：让一个两阶段工作流通过生产 HTTP 入口真实执行，而不是测试直接调用内部类。

任务：

- [x] 建立 `WorkflowRuntime`，把 `TaskRunner` 收入其实现。
- [x] `/api/task/run` 改为加载项目 workflow snapshot 并启动 `WorkflowRuntime`。
- [x] 创建 task 时按 workflow 初始化 `TaskStep`，不再固定创建 `do`。
- [x] 每次运行保存 workflow schema version 和内容快照，防止运行中编辑画布改变语义。
- [x] 统一成功、失败、取消结果；error 事件会失败并阻塞下游。
- [x] 画布 connections 可编译为 fan-out、join 和下游依赖。
- [x] 跟踪后台 asyncio task，Daemon 关闭时停止引擎、取消并等待。
- [ ] 增加生产入口 E2E：HTTP start → WS events → DB states。

验收：

- 默认流程至少能用 FakeEngine 从需求跑到 UI 两阶段。
- 并行节点真实同时进入 running，join 节点只在所有依赖成功后启动。
- 任一阶段产生 error 事件后不会标记 passed。
- 重启前残留的 running 状态能被识别并转为 interrupted。

### R2：项目隔离与运行持久化（5–7 人日）

**目标**：保证不同项目、不同任务和并行阶段互不污染，运行崩溃后仍可诊断。

任务：

- [x] 用 task-local `ProjectContext` 替换后台运行中的进程级数据库绑定。
- [x] 增加 `workflow_runs`、`step_runs` 表，区分阶段定义和每次 attempt。
- [ ] 补齐 user/assistant messages；position 按会话递增。
- [ ] 事件和文本按批次增量落库，不等到运行结束。
- [ ] usage、prompt snapshot、engine、model、started_at、ended_at 全量记录。
- [x] 实现取消后的 task/step/workflow run/message 一致状态收尾。
- [ ] 修正 pause：v1 若不支持进程挂起，应定义为“停止调度新阶段，当前阶段继续或取消”，不能只改字段。

验收：

- 两个项目并发执行、查询、取消时数据完全隔离。
- 强制终止 Daemon 后，已写事件和文本可恢复查看。
- 同一阶段重试两次产生两个 step_run，不覆盖上一版本。

### R3：可靠事件流与前端运行状态（4–6 人日）

**目标**：让前端准确展示多阶段、并行和断线重连。

任务：

- [ ] 定义统一事件 envelope：`project_id/task_id/run_id/step_key/step_run_id/sequence/type/data/timestamp`。
- [ ] WebSocket 按 project/run 订阅，避免向所有客户端广播全部事件。
- [ ] 每个 run 使用单调 sequence，支持 `after_sequence` 补发。
- [ ] 应用根部只保留一个 WebSocket 连接，移除 TaskDetail 重复连接。
- [ ] Zustand 改为 `runs[taskId][stepKey][stepRunId]`，不再把所有阶段文本拼到 `content[taskId]`。
- [ ] 调用 REST 前先初始化前端 run 状态，消除“首事件到达后又被清空”的竞态。
- [ ] 修复 5 个 Hook lint warning，并增加前端 store 测试。

验收：

- 前端/后端并行输出分别显示在自己的阶段下。
- 断网重连后既不重复也不丢失事件。
- Layout 和详情页同时打开时服务端只有一个浏览器连接。

### R4：产物闭环（4–6 人日）

**目标**：把“LLM 被提示写文件”升级为可验证、可追踪的正式产物。

任务：

- [ ] 增加 `artifacts` 表：task、step_run、logical_name、path、type、version、size、hash、created_at。
- [ ] 阶段开始前记录输出目录基线，结束后发现新增/修改文件。
- [ ] 根据 outputs 契约校验必需产物；缺失时阶段失败或进入 review 状态。
- [ ] 下游 Prompt 从 `ArtifactCatalog` 获取上游产物，不直接盲扫目录。
- [ ] 提供按 task/step 查询产物的路由。
- [ ] 把 `ArtifactPreview` 接入 TaskDetail。
- [ ] 预览路由只接受 artifact id，并验证 resolved path 位于项目允许目录。
- [ ] 重试自动生成新版本，保留历史 hash 和来源 step_run。

验收：

- 第一阶段生成 Markdown 后，数据库出现 artifact，详情页可预览。
- 下一阶段 Prompt 包含登记后的准确路径。
- 重试不覆盖上一版本，可切换查看。
- 构造 `../` 或项目外路径无法预览。

### R5：完成核心交互（4–7 人日）

**目标**：使看板和详情页成为真实执行状态的投影。

任务：

- [ ] task list/get 返回 `task_steps`、active runs 和当前阶段集合。
- [ ] 删除 `cardLanes/cardStatuses` 本地事实源，泳道由后端阶段状态计算。
- [ ] 新建任务提交 description、工作目录、workflow/template 和初始输入。
- [ ] 接通开始、暂停策略、取消、删除、复制、编辑。
- [x] 复制任务只复制定义和输入，不复制 passed/running 状态。
- [ ] Canvas 保存成功后同步更新 projectStore。
- [ ] 增加引擎列表路由，在节点编辑器显示 installed/version/mode。
- [ ] 未安装引擎在保存或启动前给出明确校验错误。

验收：

- 刷新浏览器后卡片仍位于真实阶段。
- 删除、复制、取消的 UI 和数据库结果一致。
- 从新建任务到首条输出不超过 PRD 约定的三步。

### R6：会话恢复、重试与人工干预（5–8 人日）

**目标**：完成 PRD 中断续跑和失败处理能力。

任务：

- [ ] 增加 `agent_sessions` 表和 session adapter。
- [ ] 从 Claude/ACP 初始化事件获取 session id，并与 task/step/engine 关联。
- [ ] 实现“重试当前阶段”“从此阶段重新运行”“继续会话”。
- [ ] 重跑时按规则重置所有下游 step 状态，但保留历史 step_run。
- [ ] `InterventionManager` 接入实际引擎执行循环，而不是只保留独立 Future 管理器。
- [ ] 前端渲染问题/权限请求并通过同一 WebSocket 返回。
- [ ] 超时、取消、浏览器断线均有确定状态。

验收：

- Claude 关闭详情页再打开后可恢复同一 session。
- 失败阶段重试不会重新执行无关的已完成上游阶段。
- 一次人工问题可以从前端回答并被引擎收到。

### R7：引擎可靠性与真实契约测试（5–10 人日）

**目标**：把“存在 adapter”提升为“真实 CLI 版本可运行”。

任务：

- [ ] 为 Claude、Codex、Hermes 建立录制 fixture 和真实 smoke test。
- [ ] 并发读取 stdout/stderr，避免 stderr 管道填满导致死锁。
- [ ] 修复 Claude 单事件多 content block 丢失问题。
- [ ] 明确 ACP transport/process 生命周期，使 stop 和 session 真正生效。
- [ ] Hermes prompt 完成后可靠关闭/复用 session，不等待永不退出的进程。
- [ ] API engine 改为边读取边 yield，补充 `raise_for_status`、provider 配置和 runtime `httpx` 依赖。
- [ ] API Base 默认只允许 HTTPS 或明确的 loopback 本地端点，阻止 SSRF。
- [ ] QCode/OpenClaw 在协议调研和真实 smoke test 完成前标记 experimental，不进入默认 registry。
- [ ] 增加 Windows 高权限确认和 Claude 环境变量清理。

验收：

- 三个 P0 引擎各有固定支持版本和可复现 smoke test。
- stop 能在限定时间内回收进程，无僵尸进程。
- 第一个 `text_delta` 的延迟有测量记录。
- API engine 的文本确实逐块到达前端，而不是请求完成后批量出现。

### R8：条件、模板、搜索与历史体验（4–7 人日）

**目标**：在核心闭环稳定后接回外围功能。

任务：

- [ ] 条件放在 edge 上，并定义可验证的表达式 schema。
- [ ] 调度器维护 step outcomes，正确标记 skipped/blocked。
- [ ] 画布支持编辑和展示 edge condition。
- [ ] 模板列表、预览、应用和自定义保存接入前端。
- [ ] 修复 sessions 查询和跨项目聚合。
- [ ] 搜索 UI 接入，并修正 total 计算、参数命名和项目作用域。
- [ ] 历史页按 run/step 展示文本、思考、工具、用量和产物。

验收：

- 条件为 false 的节点显示 skipped，不会让任务永久 paused。
- 应用模板后得到可编译且可运行的 workflow。
- 搜索和会话列表在两个项目中返回正确且隔离的数据。

### R9：发布、安全、可观测和文档收口（4–6 人日）

**目标**：形成可交付的本地应用基线。

任务：

- [ ] 路径授权、符号链接逃逸、命令参数和敏感日志安全测试。
- [ ] 记录 run duration、token usage、退出码和错误分类。
- [ ] 增加结构化日志字段：project/task/run/step/engine。
- [ ] 增加健康检查：数据库可用性、引擎安装状态、前端版本。
- [ ] 修复 EventBus 测试资源警告。
- [ ] 增加 CI：后端测试、前端 build/lint、schema 校验、E2E。
- [ ] 补充根 README：安装、启动、支持引擎、数据目录、故障排查。
- [ ] 将旧文档统一为 WorkStep + Python/FastAPI + WebSocket，不再保留失效的 TypeScript/SSE 文件落点。

验收：

- 全新机器按 README 可启动。
- CI 无 warning 通过。
- 用默认模板完成一次真实的最小工作流，有可查看的事件、产物和历史。

## 7. 里程碑建议

| 里程碑 | 包含阶段 | 可交付结果 |
|---|---|---|
| M0 · 架构一致性 | R0 | 画布定义、执行定义和数据库 schema 统一 |
| M1 · 可运行 MVP | R1–R3 | 生产入口可执行多阶段 DAG，状态和事件可靠 |
| M2 · 可用工作闭环 | R4–R5 | 产物、看板、详情页和卡片操作完整 |
| M3 · 可恢复工作流 | R6 | 会话恢复、阶段重试、人工干预 |
| M4 · 多引擎稳定版 | R7 | Claude/Codex/Hermes 真实契约通过 |
| M5 · 产品完善 | R8–R9 | 条件、模板、搜索、历史、安全与发布 |

建议先承诺 M1，而不是同时推进全部 P5 功能。R0–R3 完成前，QCode、OpenClaw、模板市场、Langfuse 等功能都不应进入关键路径。

## 8. 测试策略调整

当前测试数量不能直接代表完成度。后续测试应以深模块的 interface 为测试面：

1. `WorkflowDefinition`：使用纯 JSON fixture，验证 compile 输出和错误。
2. `WorkflowRuntime`：使用临时项目 SQLite、临时文件系统和 FakeEngine adapter，验证完整可观察结果。
3. `EngineAdapter`：使用录制的真实 stdout/ACP fixture；另设可选真实 smoke test。
4. HTTP/WS E2E：只能从公开入口启动，不能直接 new `TaskRunner`。
5. 浏览器 E2E：创建项目、编辑两节点画布、启动、观察阶段推进、预览产物、刷新回放。
6. 并发测试：两个项目、两个任务、同任务 fan-out 三种场景。
7. 故障测试：引擎缺失、error event、非零退出、Daemon 中断、WS 断线、磁盘写失败。

旧的浅层测试在对应深模块 interface 测试建立后应逐步替换，避免实现重构时大量测试随内部细节一起修改。

## 9. 每阶段完成定义

一项功能只有同时满足以下条件才可标记完成：

- 生产入口已接通，不是仅能直接调用内部类。
- 状态和数据在刷新、重启或重连后仍一致。
- 失败、取消和超时路径有明确结果。
- 自动化测试覆盖公开 interface 和至少一条纵向链路。
- 前后端使用同一 schema，不靠重复常量维持一致。
- 安全限制默认生效。
- 相关文档和验收清单同步更新。

## 10. 主链路开发队列

按可独立提交的顺序拆分：

1. [x] `WorkflowDefinition v1` schema、校验器和画布格式编译器。
2. [x] SQLite schema version + migration runner。
3. [x] `workflow_runs` / `step_runs` 数据模型与状态枚举。
4. [x] `WorkflowRuntime.start()` 及 FakeEngine 纵向测试。
5. [x] `/api/task/run` 切换到 `WorkflowRuntime` 并返回 run_id。
6. [x] error/cancel outcome 语义修复。
7. [x] task-local `ProjectContext`，消除后台运行中的进程级 DB 重绑。
8. [ ] 统一事件 envelope 和单 WebSocket 前端连接。
9. [ ] TaskDetail 按 step_run 展示实时输出。
10. [ ] ArtifactCatalog 与 Markdown 产物纵向闭环。

完成上述十项后，WorkStep 才真正具备继续扩展会话恢复、条件路由和更多引擎的稳定底座。
