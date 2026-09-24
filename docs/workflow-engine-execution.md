# 工作流引擎执行全景

本文是 WorkStep 工作流执行语义的权威说明，覆盖任务创建、调度、步骤执行、产物路由、审核、返回线、人工消息、协调助手重跑和进程恢复。实现与本文冲突时，以代码和测试为准，并同步修正文档。

配套图：

- [工作流引擎执行全景图](diagrams/workflow-engine-execution.md)：生命周期、步骤执行和人工控制三张可直接预览的图。
- [步骤提示词与端口产物路由详图](diagrams/task-stage-prompt-flow.svg)：输入快照、审核门和正向/返回路由细节。

## 核心对象与不变量

| 对象 | 作用 | 不变量 |
|---|---|---|
| `Task` | 一个用户任务的当前总体状态 | `active_workflow_run_id` 指向当前运行；`state_version` 用于协调动作并发校验 |
| `TaskStep` | 每个步骤的当前状态投影 | 只表示“现在是什么状态”，不替代历史记录 |
| `WorkflowRun` | 一次完整或局部工作流运行 | 保存父运行、逻辑入口、执行范围、路由状态和租约；不复制完整流程定义 |
| `StepRun` | 步骤的一次 attempt | 保存引擎、模型、产物轮次、显式输入轮次、端口输入快照和本轮 I/O 约定 |
| `ReviewRun` | 一次自动或人工审核 | 必须绑定明确的 `StepRun` 和 `WorkflowRun` |
| `manifest.json` | 某步骤某轮产物清单 | 记录声明输出、实际文件、大小、端口和是否可向下游继承 |
| `routing_state_json` | 本次运行的动态路由状态 | 保存逻辑入口、执行范围、活动连接、返回输入、返回次数和已路由轮次 |

三个边界必须分开理解：

1. **流程定义**决定节点、连接、端口和审核配置。
2. **最新流程定义**是启动、重跑、人工审核续跑和进程恢复的统一配置来源；历史事实由步骤输入快照、I/O 约定和产物 manifest 保存。
3. **任务投影**供 UI 快速显示；真实历史以 `WorkflowRun`、`StepRun`、`ReviewRun` 和事件日志为准。

## 状态机与兜底机制

### 状态所有权

五层状态各自只回答一个问题，不能互相代替：

| 对象 | 回答的问题 | 写入原则 |
|---|---|---|
| `Task` | 用户现在看到的任务总体状态是什么 | 应由当前活动运行与步骤状态收敛得到，不作为 attempt 历史 |
| `WorkflowRun` | 这一轮完整运行或局部重跑是否结束 | 一个 run 只有一个终态；局部重跑新建子 run |
| `TaskStep` | 该步骤现在允许什么操作 | 可随重试、返工和重跑改变 |
| `StepRun` | 某一次步骤执行发生了什么 | attempt 结束后不改写为下一次结果 |
| `ReviewRun` | 某一次审核发生了什么 | 必须绑定具体 `StepRun`，旧审核不能决定新 attempt |

当前总体转换为：

```text
Task
  ready ──申请槽位──> queued ──获得槽位──> running
    │                    └──取消排队──> ready
    └──直接获得槽位───────────────────> running
  running ──全部完成──> ready
  running ──失败/等待人工──> paused
  running ──用户终止──> stopped

WorkflowRun
  running ──正常完成──> succeeded
  running ──等待人工或可恢复失败──> paused
  running ──异常收尾──> failed
  running ──用户终止──> stopped
  running/paused/failed ──局部重跑──> superseded + child running
```

`Task.ready` 当前同时表示“尚未启动”和“本轮成功完成”，读取时必须结合 `active_workflow_run_id` 与运行历史判断。后续若拆分 `succeeded` 任务状态，需要同步迁移任务列表、调度和归档判断，不能只改 UI 文案。

步骤转换为：

| 当前状态 | 触发 | 下一状态 | 必须保留的用户出口 |
|---|---|---|---|
| `pending` | 调度条件满足 | `running` | 终止任务 |
| `running` | 执行成功且跳过审核 | `passed` | 从本步骤重跑 |
| `running` | 进入自动/人工审核 | `reviewing` / `awaiting_review` | 停止；人工审核还可通过、驳回、终止 |
| `running` | 引擎错误 | `failed` | 重试、换引擎、重建会话、终止 |
| `running` | 用户停止 | `cancelled` | 继续执行、从本步骤重跑、终止 |
| `reviewing` | 通过 | `passed` | 从本步骤重跑 |
| `reviewing` | 拒绝且可重试 | `retrying` / `rework` | 停止、转人工 |
| `reviewing` | 重试耗尽 | `awaiting_review` | 通过、驳回、终止 |
| `awaiting_review` | 通过 | `passed`；下游仍独立校验必需产物 | 从本步骤重跑 |
| `awaiting_review` | 驳回 | `retrying` | 停止、终止 |
| `rework` / `rework_waiting` | 再次被调度 | `running` | 停止、终止 |
| 任意可执行状态 | 路由冲突、返回超限或必需输入无法满足 | `failed`；未来可细分为 `blocked` | 修复后重跑、终止 |
| 未进入本次执行范围或可选分支未选择 | 范围/路由裁剪 | `skipped` | 显式从本步骤启动 |

Codex SDK 的运行中 `error` 通知可能只是重连进度，先记入原生事件日志；只有最终 `turn/completed` 报失败，或收到错误通知后事件流未正常完成，才作为引擎错误。引擎层对真正的执行错误最多再重试一次；正常完成后才进入配置的审核。

### `skipped`、`failed` 与必需输入

`skipped` 只能表示“本轮无需执行”，包括：

- 创建任务时选择起始步骤后，范围外步骤被裁剪；
- 多输出或条件分支中，该输出端口本轮没有产物，因此对应可选分支未被选择。

以下情况不是正常 `skipped`：

- 唯一正向输出或其它必经实线声明了产物，但文件缺失或为空；
- 人工通过了步骤，但下游全部必需输入仍无法满足；
- 路由状态损坏，导致本应存在的活动连接丢失。

当前实现只在同一来源步骤已有其它正向实线端口被激活时，才把未选中分支标记为 `skipped`。若来源步骤没有任何可路由的正向非空产物，相关下游步骤按 `failed` 收敛并发布 `required_input_missing`。普通通过和强制通过都只改变审核结果，不伪造缺失文件；用户同意后恢复调度，缺少必需产物的下游会明确失败。

### 永不失联原则

任何非终态必须同时满足：

1. 有一个持久化的等待原因，例如并发槽位、引擎执行、用户交互、人工审核或重试计划；
2. 有自动推进或超时收敛路径；
3. UI 至少提供停止/终止或从步骤重跑中的一个有效出口；
4. 操作不依赖某个仍然存在的 Python 对象，持久化状态异常时仍可强制收尾。

目标兜底矩阵：

| 观察到的持久化状态 | 自动处理 | 用户操作 |
|---|---|---|
| `queued`，但不在内存队列 | 重新注册；若已有槽位则立即启动 | 取消排队 |
| `running`，runner 与租约正常 | 继续执行和续约 | 停止步骤或任务 |
| `running`，runner 缺失且租约过期 | 在线巡检接管或收敛为 `paused` | 强制收尾、从步骤重跑 |
| `running`，runner 缺失但租约仍新鲜 | 等待短暂宽限窗口后复查 | 管理员强制接管/收尾 |
| `reviewing`，审核引擎缺失 | 转人工审核或标记失败 | 转人工、重跑、终止 |
| 存在未回答交互但执行已不存在 | 写入取消响应并关闭消息 | 从步骤重跑 |
| `WorkflowRun=running`，但没有活动步骤、等待审核或排队原因 | 判定为孤儿运行并暂停 | 强制收尾、从步骤重跑 |

上述巡检与用户停止入口已实现。巡检每 15 秒复用恢复准备逻辑：存在本地 runner 的任务不动；本实例 runner 缺失的运行立即接管；其它实例仍持有新鲜租约时不抢占，后续巡检在租约过期后再恢复。停止操作若找不到 runner，会直接更新活动步骤、运行、消息和审核状态，然后释放租约与并发槽位。

### 强制收尾事务

在线巡检或用户执行强制收尾时，应在一个项目数据库工作单元内完成：

1. 校验 `Task.active_workflow_run_id` 和 `state_version`，避免收尾旧运行；
2. 将活动 `StepRun` 置为 `cancelled` 或 `failed`；
3. 将活动 `ReviewRun` 置为 `cancelled`，封存未回答交互；
4. 将相应 `TaskStep` 置为 `cancelled` 或 `failed`，记录机器可识别原因；
5. 将 `WorkflowRun` 置为 `failed` / `stopped` 并释放租约；
6. 将 `Task` 收敛为 `paused` / `stopped`，增加 `state_version`；
7. 事务提交后释放并发槽位并发布最终状态事件。

### 协调助手状态

协调助手的对话和确认动作不使用 `WorkflowRun`，但遵循同样的“非终态必须可恢复、可停止”原则：

```text
CoordinatorSession
  active ──换引擎/供应商──> reset ──下次 turn 建立会话──> active

CoordinatorTurn
  queued ──获得任务内串行锁──> running
  running ──完成──> succeeded
  running ──引擎/解析错误──> failed
  queued/running ──用户停止──> stopped
  queued/running ──内存任务丢失──> queued ──重新调度──> running

ActionProposal
  pending ──确认──> executing ──完成/异常──> succeeded | failed
  pending ──取消──> cancelled
  pending ──任务版本变更──> expired
  executing ──内存操作丢失──> failed
```

内存中的 `_scheduled_turns`、`_running_engines` 和 `_executing_actions` 只是活动所有权，不是权威历史。daemon 启动时先扫描持久化状态，启动后每 15 秒继续巡检：

- 没有任何内存所有者的 `queued/running` turn 重置为 `queued` 并重新调度；
- 停止优先选择 `running` turn，只在没有运行项时才选择最新 `queued` turn，避免排队/插入消息遮蔽真正的活动引擎；
- 停止孤儿 turn 直接把 `CoordinatorTurn` 和助手 `Message` 收敛为 `stopped`，不依赖 engine 对象；
- 停止活动 turn 同时取消待回答交互，引擎停止最多等待 10 秒；
- 没有内存执行者的 `executing` 提案收敛为 `failed`。不自动重放，避免重复补充、重跑或审核决定。

强制收尾必须幂等：重复调用只能返回同一终态，不能再次取消新的子运行。

## 一、任务创建与启动

任务可以从 REST、定时任务、任务派发或任务创建助手进入统一的 `create_project_task` seam。

### 执行模式与计划启动

| 配置 | 创建后行为 |
|---|---|
| `workflow` | 读取所选起始步骤的 `autoStart`；为真时立即启动，否则保持 `ready` |
| `immediate` | 无条件立即启动 |
| `manual` | 只创建任务，不启动 |
| 同时设置 `scheduled_start_at` | 保存计划时间，调度器到时以 `scheduled_start` 来源启动；它不是第四种 `execution_mode` |

`autoStart` 只控制任务创建后是否自动启动，不是“步骤级人工门”。没有连接的步骤如果属于本次执行集合，仍是 DAG 根节点，会与其他根节点并行运行。

### 选择起始步骤

创建任务时可以传 `start_step_key`。当前实现计算：

```text
执行集合 = 起始步骤 + 它的全部正向下游
其它步骤 = skipped
```

因此“其它步骤”既可能是起始步骤的上游，也可能是与它无关的孤立节点或旁支。这个 `skipped` 是任务创建时的范围裁剪，和审核模式 `skip` 不是一回事。

首次建立 `WorkflowRun` 时，引擎把所选起始步骤持久化为本轮的逻辑入口 `entry_step_key`，并把“入口 + 正向下游”持久化为 `execution_scope`。这两个字段属于运行语义，不能在恢复时仅凭当前 `TaskStep.skipped` 重新猜测；动态路由产生的 `skipped` 不得被误认成用户选择了新的起点。

逻辑入口可以有实线上游，但这些上游若在本轮 `execution_scope` 之外，其每一条入口连接分别由任务上下文满足。例如 C 的两个输入端口分别连接 A2、B1，而本轮直接从 C 启动，则 A2、B1 两个端口仍各自存在，状态都为 `task_context`；系统不会伪造 A2/B1 产物文件，也不会把两个输入合并成一个。用户若显式选择了某个上游产物轮次，该真实产物优先，不再由任务上下文替代。

如果没有 `start_step_key`，所有步骤初始为 `pending`；所有无实线依赖的根节点都可能开始执行。

## 二、并发排队与运行建立

`WorkflowRuntime.start` 先向 `ConcurrencyGate` 申请任务槽位：

1. 已在排队或运行：拒绝重复启动。
2. 没有槽位：任务进入 `queued`，按 FIFO 等待；用户可取消排队并回到 `ready`。
3. 获得槽位：创建 `WorkflowRun`，保存运行租约和运行关系，将任务置为 `running`。

调度来源包括 `manual`、`schedule` 和 `scheduled_start`。项目可以配置定时任务是否豁免任务并发限制。

## 三、DAG 调度与步骤选择

`TaskRunner` 将启动或恢复时读取的最新流程编译成 `DAGScheduler`。步骤可执行需要同时满足：

- 步骤尚未完成、运行或失败；
- 所有 DAG 依赖已经满足；
- 所有实线输入连接都已被对应的非空产物激活；
- 步骤属于本次 `execution_scope`，或者本次是完整运行。

逻辑入口是唯一例外：来自本轮范围外的实线输入连接可以逐连接标记为 `task_context`，从而只解除入口本身的调度阻塞。入口之后的下游步骤没有这个例外，仍必须等待真实、非空且已激活的产物连接。因此“直接启动 C”不会让 C 之后的 D 绕过其正常输入校验。

汇合节点要求每条实线输入连接都激活。一个源步骤完成，不代表它所有输出端口都有效；只有 manifest 中 `nonempty=true` 的声明输出才能激活从该端口出发的连接。

动态路由中没有被产物激活的可选分支会标记为 `skipped`。这是“本轮其它端口已被选中”，不同于创建任务选择起点时的范围裁剪；来源步骤无任何正向非空产物时，必需输入按前述状态机规则失败。诊断可通过 `required_input_missing`、manifest 和连接拓扑区分两者。

[查看 A1/A2 分流与 B 多输入等待示例图](diagrams/artifact-port-fanout.svg)。图中 A1、A2 分别激活 B、C；B 还必须等待 D1，三个端口不会因为同属一个步骤而合并判断。

## 四、步骤提示词与输入快照

步骤执行前，运行时先解析 `StepRun.input_snapshot_json`，再把内部状态投影为面向 LLM 的语义化提示词。完整顺序为：

1. WorkStep 步骤系统指令；
2. 项目 `.workstep/MEMORY.md`；
3. `Task.title`；
4. `Task.description`；
5. 外部任务派发的输入 manifest；
6. 当前步骤的执行原因和有效输入产物；
7. `step.prompt` 步骤要求；
8. 已确认的 `StepSupplement`；
9. 输出产物名称、类型、精确轮次目录和路由语义；
10. 定向到当前步骤的本次用户输入。

端口序号、连接 ID、项目 ID、任务 ID、派发 ID、下游步骤 key 和原始实线/虚线标记只服务于运行时调度，不注入 LLM。普通正向输出不添加路由提示；只有当某个输出代表返工请求时，才说明它应在需要修订时生成。步骤无需理解完整流程图，也无需知道自己位于第几个节点。

启动流程时附带的用户输入只注入消息所归属的目标步骤，不再复制到后续每一个步骤；后续步骤通过声明输入产物获得所需上下文。

端口快照状态：

| 状态 | 含义 |
|---|---|
| `ready` | 至少一条活动连接提供了可用产物 |
| `inactive` | 输入端口有连接，但本轮没有连接被激活 |
| `task_context` | 输入端口没有连接，或该连接的来源在本轮入口范围之外；输入由任务标题、任务说明、派发输入和用户补充共同提供 |

步骤只自动获得直接输入连接的产物，不自动获得整个任务所有产物。任务协调助手拥有全局任务、步骤和产物索引，可按用户意图读取必要产物并将整理后的内容作为 `StepSupplement` 注入目标步骤。

可恢复会话的多轮执行采用增量提示词：首次执行发送完整任务与步骤契约；审核驳回、人工驳回或虚线返回时，只发送本轮有效输入、反馈和新的输出路径，不重复任务说明与步骤要求。引擎不支持恢复或会话已失效时，回退为完整提示词。

## 五、引擎执行、事件与实时消息

引擎通过 `AcpEngineBase` 统一运行，内部产出 ACP 对齐事件。完整事件先写入 JSONL 日志，再生成消息摘要，通过 `EventBus` 翻译成 AG-UI，供 WebSocket 实时流和历史回放共用。

步骤运行期间支持：

- 普通 `@步骤` 消息：发送到当前引擎会话；
- guidance：作为引擎交互/指导输入；
- 停止步骤：调用引擎取消并保留可恢复 session；
- 待插入消息：先绑定正在运行的 assistant Message，步骤结束后按顺序合并，再触发下一轮；
- 引擎空闲超时：停止引擎并将步骤标记为失败，但保留 session 供恢复。

能够原生恢复的引擎复用 `session_id`。更换引擎或供应商时不能复用旧 session，运行时生成结构化上下文交接并创建新会话。

任务详情的步骤输入框提供一次性的“重置步骤”开关，仅在该步骤已有执行历史且当前没有运行时显示：

- 未选中时，继续复用该任务该步骤保存的 `session_id`，只发送本次消息和本轮输出约束；
- 选中后，本次发送创建新的局部子运行，并在创建子运行的同一事务中清除目标步骤当前的 `session_id`、`session_provider` 和待交接指针；
- 新执行不向引擎传旧 `session_id`，因此重新注入最新任务信息、步骤要求、当前有效输入产物、本次消息和输出约束；
- 新引擎会话建立后，`TaskStep.session_id` 指向新的会话；旧消息、事件日志、产物和历史运行不会删除；
- 重置只对本次发送生效，成功排队后前端恢复为未选中；发送失败时保留选择，允许用户修正后重试；
- 步骤正在运行时仍使用实时消息/待插入消息机制，不能同时重置；需要全新执行时先停止步骤。

“重置步骤”只改变目标步骤的引擎上下文策略，不改变局部重跑范围：目标步骤及其实线下游进入新子运行，范围外的并行或上游活动步骤仍按局部重跑规则取消。若会影响其他活动步骤，前端必须先展示影响确认。

## 六、产物轮次与选择

产物目录：

```text
.workstep/artifacts/<workflow>/<task>/<step>/<round>/
├── manifest.json
└── ...产物文件
```

正常下游选择规则：

1. 用户或协调助手显式指定 `input_rounds` 时，使用指定轮次并校验它属于目标步骤的直接依赖；
2. 否则选择该上游步骤最新的 `eligible_for_downstream=true` 轮次；
3. 失败、取消和中断的 attempt 不保留产物轮次；
4. 审核驳回的产物可以保留，但不能成为默认下游输入。

轮次归属于产生产物的步骤，各步骤独立计数。某步骤再次执行时会预留下一产物轮次；只有实际执行并保留下来的轮次才成为可供下游使用的产物，失败或中断会清理未完成轮次。下游步骤重试或返工不会让上游产物自动升级。步骤编号也不要求对齐，例如可以出现“需求第 1 轮 → 开发第 3 轮 → 测试第 3 轮”。

界面还显示另外两种不同计数：`Task.run_round` 是本任务第几次流程运行（由父子 `WorkflowRun` 深度决定），不等于任一步骤的产物轮次；产物浏览器的标签是当前已存在、可查看的产物轮次。正在执行的步骤与其消息应显示已预留的当前 `StepRun.artifact_round`，即使该轮文件尚未生成。例如流程第 2 次运行中，开发正执行第 3 轮，而浏览器仍只能查看已产出的第 2 轮产物。

典型研发返工过程如下：

```text
需求第 1 轮 → PRD 第 1 轮
开发第 1 轮 → 测试第 1 轮 → Bug 列表第 1 轮
开发第 2 轮输入 = PRD 第 1 轮 + Bug 列表第 1 轮
测试第 2 轮 → Bug 列表第 2 轮
开发第 3 轮输入 = PRD 第 1 轮 + Bug 列表第 2 轮
```

只要需求步骤没有重新执行，就不存在 PRD 第 2 轮。测试通过返回线要求开发返工时，只增加开发和后续实际重跑步骤的轮次，不改变需求步骤的轮次。

局部重跑创建子运行时，已经明确写入子运行的 `reused` / `succeeded` `StepRun.artifact_round` 优先于旧 manifest 的选择标记，并固定到目标步骤的 `input_rounds`。这样旧数据中 TaskStep/ReviewRun 已通过、但 manifest 未及时更新的情况不会让目标步骤被错误跳过。

## 七、审核流程

审核模式：

| 模式 | 行为 |
|---|---|
| `skip` | 不创建审核等待，但产物仍必须经过 manifest 和端口路由 |
| `auto` | 审核引擎判断；失败时按 `review.maxRetries` 重试当前步骤，耗尽后暂停 |
| `manual` | 步骤进入 `awaiting_review`，等待用户通过、驳回或强制通过 |

人工通过会：

- 将 `ReviewRun` 和 `TaskStep` 置为通过；
- 把本轮 manifest 更新为 `eligible_for_downstream=true`；
- 根据非空端口更新 `routing_state_json`；
- 恢复同一个 `WorkflowRun` 的下游调度。

人工驳回只重试当前步骤并携带审核反馈，不会自动触发画布虚线。虚线是否触发只由实际返回端口产物决定。

自动审核只接收一份执行契约：首次审核使用完整执行提示词，后续可恢复重试使用增量执行提示词。审核拒绝后，下一轮执行统一收到一份 `Previous review feedback`：人工拒绝时原样传递用户填写的意见，自动拒绝时原样传递审核 LLM 的回复。结构化审核报告只用于流程判断和界面展示，不由流程引擎重新拼装后注入。`skip` 不创建审核提示词；人工通过或强制通过也不再次调用 LLM。

步骤执行与审核是两个独立检查点：执行引擎成功后，先将 `StepRun` 和执行消息记为 `succeeded`，再进入审核；此时 `TaskStep=reviewing` 表示整个步骤尚未通过，**不表示执行引擎仍在运行**。人工审核等待使用 `awaiting_review`。只有审核通过后，步骤才变为 `passed`，产物才可向下游路由。

停止步骤的作用范围包含该步骤当前正在运行的执行引擎或自动审核引擎。审核中停止时，已成功的执行记录不回退，审核记录及审核消息以中止状态收尾，步骤变为 `cancelled`；前端在 `reviewing` 时仍提供同一个步骤的停止入口，但不向审核中的步骤发送执行中插入消息。

## 八、正向路由、返回线和暂停

步骤通过审核后，`route_artifact_round` 检查本轮输出：

- 只有正向端口非空：激活对应实线，下游继续；
- 只有返回端口非空：目标步骤及其正向下游进入返工；
- 正向和返回端口同时非空：路由冲突，流程暂停；
- 返回次数超过 `maxReturnRounds`：流程暂停；
- 某条件分支未产出对应文件：该分支本轮不触发。

`maxReturnRounds` 属于步骤返回路由限制，默认 3、范围 1–20；它和自动审核的 `review.maxRetries` 相互独立。

返回目标重新执行时，运行时保留其它已经激活的输入端口。例如测试返回开发时，开发步骤可以同时得到原始 PRD 和本轮 Bug 列表。

实线和反向虚线的启动语义不同：

- 实线是必需输入，步骤只有在所有实线输入连接都已激活后才能启动；
- 反向虚线不是首次启动的必需输入，没有 Bug 列表时开发仍可凭 PRD 首次执行；
- 虚线端口产出非空文件时，它主动触发目标步骤及其正向下游返工，但不能替代缺失的实线输入；
- 多轮返工中，目标步骤使用仍然有效的实线输入轮次，加上本轮最新的返回产物。

## 九、用户对步骤的后续操作

### 正在运行的步骤

`POST /api/task/{task}/step/{step}/message` 把消息实时注入当前步骤，不创建新的工作流运行。

### 已停止、失败、通过或跳过的步骤

`resume_step_with_message` 会：

1. 把用户消息保存到步骤执行历史；
2. 将本次消息作为目标步骤的单轮 follow-up 注入，不自动升级为长期补充；
3. 如有待处理人工审核，将旧审核标记为被新消息取代；
4. 从该步骤创建子运行，并执行该步骤及其 DAG 下游。

只要当前轮仍有活动步骤，向另一个可重跑步骤发送消息前，前端必须显示确认框。确认框不能假设流程是单链：它应列出当前轮所有会先停止的活动步骤，并进一步区分“属于目标步骤及其正向下游、将在子运行中重新执行”和“并行或上游且不属于新范围、将保持取消”两组。用户取消时不得调用重跑接口，输入草稿必须保留。

从未启动且没有历史的普通 `pending` 步骤不能直接使用这条“恢复”路径；协调助手的确认动作使用独立的 `restart_from_stage` 入口。

### session 丢失

`restart_step_with_fresh_session` 清除步骤 session 和交接状态，以完整步骤提示词重新运行目标步骤及其下游。

## 十、协调助手动作

协调助手拥有任务总体状态、步骤状态、审核记录和产物索引，但不能直接执行副作用。它最多生成一个持久化动作提案：

- `supplement_step`：只保存目标步骤补充；
- `rerun_from_step`：从目标步骤创建子运行，可携带动态 `content` 和 `input_rounds`；
- `review_decision`：处理明确的待审核记录。

用户确认时必须通过：

- `Idempotency-Key` 检查；
- 任务 `state_version` 检查；
- 活动运行和审核记录版本检查。

确认 `rerun_from_step` 后，协调助手提供的 `content` 同时保存为 `StepSupplement` 并注入本轮目标步骤。目标步骤及其 DAG 下游重跑；范围外步骤不执行。

没有连接的孤立步骤没有下游，所以从它重跑时只执行它自己。它不会自动获得其它步骤产物；协调助手应先读取任务全局状态和必要产物，再把整理后的上下文注入该步骤。

### “流程步骤”派发到目标流程

`task_dispatch`（界面中的“流程步骤”）通过 `targetStartStepKey` 创建一个独立的目标任务。它不使用另一套特殊调度逻辑，而是复用同一套“选择起始步骤”契约：

1. 目标步骤成为新任务首轮的逻辑入口；
2. 只有目标步骤及其正向下游属于执行范围，目标流程中的其它步骤初始为 `skipped`；
3. 目标入口位于范围外的多个实线输入逐端口标记为 `task_context`；
4. 源流程复制过来的文件继续通过目标任务的输入 manifest 注入，不伪装成目标流程 A2、B1 等内部产物轮次；
5. 本地派发、远程派发、立即启动和遵循目标步骤 `autoStart` 的路径必须保持同样语义。

因此，把任务交接到目标流程 C，且 C 同时有 A2、B1 两个输入时，不会错误启动目标流程中的 A 或 B；C 会看到两个独立输入端口以及派发任务上下文。若业务要求某个端口必须是目标流程内部真实产物，就不应直接从 C 启动，而应选择能生产该产物的更上游入口。

## 十一、从指定步骤重跑

`restart_from_stage` 的语义不同于“创建任务时选择起点”：

| 行为 | 创建任务选择起点 | 已有任务从步骤重跑 |
|---|---|---|
| 流程来源 | 创建时流程定义 | 当前流程定义，而非父运行旧快照 |
| 新运行 | 首次 `WorkflowRun` | 创建带 `parent_run_id` 的子运行 |
| 执行范围 | 起点及其下游 | 目标步骤及其下游 |
| 范围外步骤 | 初始写为 `skipped` | 不执行；已通过步骤可创建 `reused` StepRun |
| 上游输入 | 由所选范围和输入决定 | 复用已有通过产物，支持显式轮次 |
| 孤立步骤 | 若不在执行集合则 `skipped` | 只有它是目标时才执行 |

重跑建立后：

1. 停止当前 runner；
2. 父运行标记为 `superseded`；
3. 使用当前流程定义建立子运行快照；
4. 目标步骤成为子运行逻辑入口，目标步骤及下游准备重新执行；
5. 范围外已通过步骤写入 `reused` StepRun；
6. 用子运行明确复用的轮次恢复活动连接和输入轮次；
7. 调度目标步骤，再按实际产物推进下游。

切换入口时，旧运行中正在执行但不属于新范围的步骤会被取消，不会为了保留“进行中”状态而偷偷并入子运行。例如 A 第二轮运行中，用户停止 A 并直接 `@C`，新运行只包含 C 及其下游；A 不会继续执行。反过来从 `@A` 启动时，C 若是 A 的正向下游，才会自然进入新范围。

如果任务从未有活动运行，则创建第一条 `WorkflowRun`，从目标步骤及其下游开始，并复用范围外已通过步骤。

## 十二、流程编辑与旧任务

完整运行使用启动时快照；重跑使用当前流程定义。两者结合意味着：

- 运行中修改画布不会改变当前运行；
- 下一次从步骤重跑会采用新节点、连接、引擎和模型；
- `TaskRunner` 启动时会为当前流程缺失的 `TaskStep` 执行 `get_or_create`；
- 协调助手创建提案前仍要求目标步骤已经存在于任务的 `TaskStep` 投影中。

因此，旧任务刚新增一个步骤后，协调助手可能暂时无法直接把它作为提案目标；经过一次采用当前流程的运行/重跑后，投影会补齐。若产品要支持“新增后立即由协调助手启动”，应在流程保存或提案校验步骤显式同步 TaskStep，而不是依赖一次运行带出。

## 十三、进程重启恢复

daemon 启动时执行两类恢复：

### 运行恢复

- 扫描仍为 `running` 的 `WorkflowRun`；
- 若另一个实例持有新鲜租约，不抢占，等租约过期后重试；
- 将旧的运行中 `StepRun` 标记为失败并丢弃未完成产物轮次；
- 仅把执行尚未成功的 `TaskStep` 恢复为 `pending`；已有成功 `StepRun` 的步骤保留执行结果并进入 `reviewing`；
- 对中断的自动审核记录和审核消息收尾，然后只重新执行审核，不再创建第二条步骤执行记录，也不丢弃已成功的产物轮次；
- 封存未回答的交互请求和仍在转圈的消息；
- 读取项目最新流程定义，从最后完成位置继续；已执行阶段的真实输入和产物仍以 `StepRun` 与 manifest 为准。
- 恢复本轮持久化的 `entry_step_key` 和 `execution_scope`；入口边界输入仍按原来的逐连接 `task_context` 语义处理，不扩大为完整流程运行。

同一恢复准备逻也由常驻心跳循环每 15 秒调用，所以 daemon 进程仍存活但 runner 丢失时不必等待重启。巡检不会为每个新鲜的外部租约创建额外计时器，而是在下一轮继续复查。

### 队列恢复

持久化为 `queued` 的任务重新注册到内存并发队列，继续按 FIFO 等待；取消等待会回到 `ready`。

重新注册时若直接获得空闲槽位，会立即创建启动协程；若重新进入等待队列，则创建等待协程。两条路径都能离开“仅持久化 `queued`、但内存中无对应项”的状态。

## 十四、状态解释

### Task 状态

| 状态 | 含义 |
|---|---|
| `ready` | 未启动，或本次运行已正常收尾 |
| `queued` | 等待任务并发槽位 |
| `running` | runner 正在执行或恢复调度 |
| `paused` | 失败、审核耗尽、返回上限或路由冲突，需要人工处理 |
| `stopped` | 用户明确终止当前运行；仍可从选定步骤创建新的子运行 |

### TaskStep 常见状态

| 状态 | 含义 |
|---|---|
| `pending` | 本次尚未执行 |
| `running` | 引擎正在运行 |
| `reviewing` | 自动审核运行中 |
| `awaiting_review` | 等待人工决定 |
| `retrying` | 审核失败后准备重试当前步骤 |
| `rework` / `rework_waiting` | 返回线要求目标或关联步骤重跑 |
| `passed` | 步骤和审核已通过 |
| `failed` | 步骤、审核或路由失败 |
| `cancelled` | 用户停止步骤 |
| `skipped` | 创建范围裁剪，或动态路由本轮没有触发该分支 |

前端只能把真实活动状态显示为“进行中”：`running`、`reviewing`、`awaiting_review`、`retrying`、`rework`、`rework_waiting`。空闲任务中的普通 `pending` 不能伪装成当前运行步骤。

## 十五、实现索引与回归测试

| 主题 | 实现 | 主要测试 |
|---|---|---|
| 创建与起始步骤 | [task_creation.py](../apps/daemon/services/task_creation.py)、[task.py](../apps/daemon/services/task.py) | [test_task.py](../apps/daemon/tests/test_task.py)、[test_task_draft.py](../apps/daemon/tests/test_task_draft.py) |
| 流程编译 | [workflow_definition.py](../apps/daemon/services/workflow_definition.py) | [test_workflow_definition.py](../apps/daemon/tests/test_workflow_definition.py) |
| 调度与步骤执行 | [task_runner.py](../apps/daemon/services/task_runner.py)、[pipeline.py](../apps/daemon/services/pipeline.py) | [test_pipeline.py](../apps/daemon/tests/test_pipeline.py)、[test_workflow_runtime.py](../apps/daemon/tests/test_workflow_runtime.py) |
| 端口路由 | [artifact_routing.py](../apps/daemon/services/artifact_routing.py) | [test_artifact_port_routing.py](../apps/daemon/tests/test_artifact_port_routing.py) |
| 产物轮次 | [artifact_rounds.py](../apps/daemon/services/artifact_rounds.py) | [test_artifact_rounds.py](../apps/daemon/tests/test_artifact_rounds.py) |
| 提示词 | [prompt.py](../apps/daemon/services/prompt.py) | [test_pipeline.py](../apps/daemon/tests/test_pipeline.py) |
| 审核 | [review_gate.py](../apps/daemon/services/review_gate.py)、[workflow_runtime.py](../apps/daemon/services/workflow_runtime.py) | [test_review_gate.py](../apps/daemon/tests/test_review_gate.py)、[test_workflow_runtime.py](../apps/daemon/tests/test_workflow_runtime.py) |
| 协调助手 | [coordinator.py](../apps/daemon/agent_assistants/coordinator.py) | [test_coordinator.py](../apps/daemon/tests/test_coordinator.py) |
| 并发与恢复 | [concurrency.py](../apps/daemon/services/concurrency.py)、[workflow_runtime.py](../apps/daemon/services/workflow_runtime.py) | [test_concurrency_gate.py](../apps/daemon/tests/test_concurrency_gate.py)、[test_recovery.py](../apps/daemon/tests/test_recovery.py) |
