# 工作流引擎执行全景

本文是 WorkStep 工作流执行语义的权威说明，覆盖任务创建、调度、阶段执行、产物路由、审核、返回线、人工消息、协调助手重跑和进程恢复。实现与本文冲突时，以代码和测试为准，并同步修正文档。

配套图：

- [工作流引擎执行全景图](diagrams/workflow-engine-execution.md)：生命周期、阶段执行和人工控制三张可直接预览的图。
- [阶段提示词与端口产物路由详图](diagrams/task-stage-prompt-flow.svg)：输入快照、审核门和正向/返回路由细节。

## 核心对象与不变量

| 对象 | 作用 | 不变量 |
|---|---|---|
| `Task` | 一个用户任务的当前总体状态 | `active_workflow_run_id` 指向当前运行；`state_version` 用于协调动作并发校验 |
| `TaskStep` | 每个阶段的当前状态投影 | 只表示“现在是什么状态”，不替代历史记录 |
| `WorkflowRun` | 一次完整或局部工作流运行 | 保存不可变流程快照、父运行、重跑起点、路由状态和租约 |
| `StepRun` | 阶段的一次 attempt | 保存引擎、模型、产物轮次、显式输入轮次和端口输入快照 |
| `ReviewRun` | 一次自动或人工审核 | 必须绑定明确的 `StepRun` 和 `WorkflowRun` |
| `manifest.json` | 某阶段某轮产物清单 | 记录声明输出、实际文件、大小、端口和是否可向下游继承 |
| `routing_state_json` | 本次运行的动态路由状态 | 保存活动连接、返回输入、返回次数和已路由轮次 |

三个边界必须分开理解：

1. **流程定义**决定节点、连接、端口和审核配置。
2. **运行快照**保证已启动运行不被后续画布编辑改变；人工“从阶段重跑”会显式使用当前流程定义创建子运行。
3. **任务投影**供 UI 快速显示；真实历史以 `WorkflowRun`、`StepRun`、`ReviewRun` 和事件日志为准。

## 一、任务创建与启动

任务可以从 REST、定时任务、任务派发或任务创建助手进入统一的 `create_project_task` seam。

### 执行模式与计划启动

| 配置 | 创建后行为 |
|---|---|
| `workflow` | 读取所选起始阶段的 `autoStart`；为真时立即启动，否则保持 `ready` |
| `immediate` | 无条件立即启动 |
| `manual` | 只创建任务，不启动 |
| 同时设置 `scheduled_start_at` | 保存计划时间，调度器到时以 `scheduled_start` 来源启动；它不是第四种 `execution_mode` |

`autoStart` 只控制任务创建后是否自动启动，不是“阶段级人工门”。没有连接的阶段如果属于本次执行集合，仍是 DAG 根节点，会与其他根节点并行运行。

### 选择起始阶段

创建任务时可以传 `start_step_key`。当前实现计算：

```text
执行集合 = 起始阶段 + 它的全部正向下游
其它阶段 = skipped
```

因此“其它阶段”既可能是起始阶段的上游，也可能是与它无关的孤立节点或旁支。这个 `skipped` 是任务创建时的范围裁剪，和审核模式 `skip` 不是一回事。

如果没有 `start_step_key`，所有阶段初始为 `pending`；所有无实线依赖的根节点都可能开始执行。

## 二、并发排队与运行建立

`WorkflowRuntime.start` 先向 `ConcurrencyGate` 申请任务槽位：

1. 已在排队或运行：拒绝重复启动。
2. 没有槽位：任务进入 `queued`，按 FIFO 等待；用户可取消排队并回到 `ready`。
3. 获得槽位：创建 `WorkflowRun`，保存当前流程快照和运行租约，将任务置为 `running`。

调度来源包括 `manual`、`schedule` 和 `scheduled_start`。项目可以配置定时任务是否豁免任务并发限制。

## 三、DAG 调度与阶段选择

`TaskRunner` 将流程快照编译成 `DAGScheduler`。阶段可执行需要同时满足：

- 阶段尚未完成、运行或失败；
- 所有 DAG 依赖已经满足；
- 所有实线输入连接都已被对应的非空产物激活；
- 阶段属于本次 `execution_scope`，或者本次是完整运行。

汇合节点要求每条实线输入连接都激活。一个源阶段完成，不代表它所有输出端口都有效；只有 manifest 中 `nonempty=true` 的声明输出才能激活从该端口出发的连接。

动态路由中没有被产物激活的条件分支会标记为 `skipped`。这是“本轮没有触发该分支”，不同于创建任务选择起点时的范围裁剪；UI 和诊断时必须结合运行记录判断来源。

[查看 A1/A2 分流与 B 多输入等待示例图](diagrams/artifact-port-fanout.svg)。图中 A1、A2 分别激活 B、C；B 还必须等待 D1，三个端口不会因为同属一个阶段而合并判断。

## 四、阶段提示词与输入快照

阶段执行前，运行时先解析 `StepRun.input_snapshot_json`，再组装提示词。完整顺序为：

1. WorkStep 阶段系统指令；
2. 项目 `.workstep/MEMORY.md`；
3. `Task.description`；
4. 外部任务派发的输入 manifest；
5. 当前阶段每个输入端口的动态快照；
6. `step.prompt` 阶段要求；
7. 已确认的 `StageSupplement`；
8. 输出产物名称、类型和精确轮次目录；
9. 本次用户输入。

端口快照状态：

| 状态 | 含义 |
|---|---|
| `ready` | 至少一条活动连接提供了可用产物 |
| `inactive` | 输入端口有连接，但本轮没有连接被激活 |
| `task_context` | 输入端口没有连接，输入来自任务上下文或用户补充 |

阶段只自动获得直接输入连接的产物，不自动获得整个任务所有产物。任务协调助手拥有全局任务、阶段和产物索引，可按用户意图读取必要产物并将整理后的内容作为 `StageSupplement` 注入目标阶段。

## 五、引擎执行、事件与实时消息

引擎通过 `AcpEngineBase` 统一运行，内部产出 ACP 对齐事件。完整事件先写入 JSONL 日志，再生成消息摘要，通过 `EventBus` 翻译成 AG-UI，供 WebSocket 实时流和历史回放共用。

阶段运行期间支持：

- 普通 `@阶段` 消息：发送到当前引擎会话；
- guidance：作为引擎交互/指导输入；
- 停止阶段：调用引擎取消并保留可恢复 session；
- 待插入消息：先绑定正在运行的 assistant Message，阶段结束后按顺序合并，再触发下一轮；
- 引擎空闲超时：停止引擎并将阶段标记为失败，但保留 session 供恢复。

能够原生恢复的引擎复用 `session_id`。更换引擎或供应商时不能复用旧 session，运行时生成结构化上下文交接并创建新会话。

## 六、产物轮次与选择

产物目录：

```text
.workstep/artifacts/<workflow>/<task>/<step>/<round>/
├── manifest.json
└── ...产物文件
```

正常下游选择规则：

1. 用户或协调助手显式指定 `input_rounds` 时，使用指定轮次并校验它属于目标阶段的直接依赖；
2. 否则选择该上游阶段最新的 `eligible_for_downstream=true` 轮次；
3. 失败、取消和中断的 attempt 不保留产物轮次；
4. 审核驳回的产物可以保留，但不能成为默认下游输入。

轮次归属于产生产物的阶段，各阶段独立计数。只有某个阶段自己再次执行并形成产物，才会增加该阶段的产物轮次；下游阶段重试或返工不会让上游产物自动升级。阶段编号也不要求对齐，例如可以出现“需求第 1 轮 → 开发第 3 轮 → 测试第 3 轮”。

典型研发返工过程如下：

```text
需求第 1 轮 → PRD 第 1 轮
开发第 1 轮 → 测试第 1 轮 → Bug 列表第 1 轮
开发第 2 轮输入 = PRD 第 1 轮 + Bug 列表第 1 轮
测试第 2 轮 → Bug 列表第 2 轮
开发第 3 轮输入 = PRD 第 1 轮 + Bug 列表第 2 轮
```

只要需求阶段没有重新执行，就不存在 PRD 第 2 轮。测试通过返回线要求开发返工时，只增加开发和后续实际重跑阶段的轮次，不改变需求阶段的轮次。

局部重跑创建子运行时，已经明确写入子运行的 `reused` / `succeeded` `StepRun.artifact_round` 优先于旧 manifest 的选择标记，并固定到目标阶段的 `input_rounds`。这样旧数据中 TaskStep/ReviewRun 已通过、但 manifest 未及时更新的情况不会让目标阶段被错误跳过。

## 七、审核流程

审核模式：

| 模式 | 行为 |
|---|---|
| `skip` | 不创建审核等待，但产物仍必须经过 manifest 和端口路由 |
| `auto` | 审核引擎判断；失败时按 `review.maxRetries` 重试当前阶段，耗尽后暂停 |
| `manual` | 阶段进入 `awaiting_review`，等待用户通过、驳回或强制通过 |

人工通过会：

- 将 `ReviewRun` 和 `TaskStep` 置为通过；
- 把本轮 manifest 更新为 `eligible_for_downstream=true`；
- 根据非空端口更新 `routing_state_json`；
- 恢复同一个 `WorkflowRun` 的下游调度。

人工驳回只重试当前阶段并携带审核反馈，不会自动触发画布虚线。虚线是否触发只由实际返回端口产物决定。

## 八、正向路由、返回线和暂停

阶段通过审核后，`route_artifact_round` 检查本轮输出：

- 只有正向端口非空：激活对应实线，下游继续；
- 只有返回端口非空：目标阶段及其正向下游进入返工；
- 正向和返回端口同时非空：路由冲突，流程暂停；
- 返回次数超过 `maxReturnRounds`：流程暂停；
- 某条件分支未产出对应文件：该分支本轮不触发。

`maxReturnRounds` 属于阶段返回路由限制，默认 3、范围 1–20；它和自动审核的 `review.maxRetries` 相互独立。

返回目标重新执行时，运行时保留其它已经激活的输入端口。例如测试返回开发时，开发阶段可以同时得到原始 PRD 和本轮 Bug 列表。

实线和反向虚线的启动语义不同：

- 实线是必需输入，阶段只有在所有实线输入连接都已激活后才能启动；
- 反向虚线不是首次启动的必需输入，没有 Bug 列表时开发仍可凭 PRD 首次执行；
- 虚线端口产出非空文件时，它主动触发目标阶段及其正向下游返工，但不能替代缺失的实线输入；
- 多轮返工中，目标阶段使用仍然有效的实线输入轮次，加上本轮最新的返回产物。

## 九、用户对阶段的后续操作

### 正在运行的阶段

`POST /api/task/{task}/step/{step}/message` 把消息实时注入当前阶段，不创建新的工作流运行。

### 已停止、失败、通过或跳过的阶段

`resume_stage_with_message` 会：

1. 把用户消息保存到阶段执行历史；
2. 创建长期有效的 `StageSupplement`；
3. 如有待处理人工审核，将旧审核标记为被新消息取代；
4. 从该阶段创建子运行，并执行该阶段及其 DAG 下游。

从未启动且没有历史的普通 `pending` 阶段不能直接使用这条“恢复”路径；协调助手的确认动作使用独立的 `restart_from_stage` 入口。

### session 丢失

`restart_stage_with_fresh_session` 清除阶段 session 和交接状态，以完整阶段提示词重新运行目标阶段及其下游。

## 十、协调助手动作

协调助手拥有任务总体状态、阶段状态、审核记录和产物索引，但不能直接执行副作用。它最多生成一个持久化动作提案：

- `supplement_stage`：只保存目标阶段补充；
- `rerun_from_stage`：从目标阶段创建子运行，可携带动态 `content` 和 `input_rounds`；
- `review_decision`：处理明确的待审核记录。

用户确认时必须通过：

- `Idempotency-Key` 检查；
- 任务 `state_version` 检查；
- 活动运行和审核记录版本检查。

确认 `rerun_from_stage` 后，协调助手提供的 `content` 同时保存为 `StageSupplement` 并注入本轮目标阶段。目标阶段及其 DAG 下游重跑；范围外阶段不执行。

没有连接的孤立阶段没有下游，所以从它重跑时只执行它自己。它不会自动获得其它阶段产物；协调助手应先读取任务全局状态和必要产物，再把整理后的上下文注入该阶段。

## 十一、从指定阶段重跑

`restart_from_stage` 的语义不同于“创建任务时选择起点”：

| 行为 | 创建任务选择起点 | 已有任务从阶段重跑 |
|---|---|---|
| 流程来源 | 创建时流程定义 | 当前流程定义，而非父运行旧快照 |
| 新运行 | 首次 `WorkflowRun` | 创建带 `parent_run_id` 的子运行 |
| 执行范围 | 起点及其下游 | 目标阶段及其下游，加上被中断阶段 |
| 范围外阶段 | 初始写为 `skipped` | 不执行；已通过阶段可创建 `reused` StepRun |
| 上游输入 | 由所选范围和输入决定 | 复用已有通过产物，支持显式轮次 |
| 孤立阶段 | 若不在执行集合则 `skipped` | 只有它是目标时才执行 |

重跑建立后：

1. 停止当前 runner；
2. 父运行标记为 `superseded`；
3. 使用当前流程定义建立子运行快照；
4. 目标阶段及下游准备重新执行；
5. 范围外已通过阶段写入 `reused` StepRun；
6. 用子运行明确复用的轮次恢复活动连接和输入轮次；
7. 调度目标阶段，再按实际产物推进下游。

如果任务从未有活动运行，则创建第一条 `WorkflowRun`，从目标阶段及其下游开始，并复用范围外已通过阶段。

## 十二、流程编辑与旧任务

完整运行使用启动时快照；重跑使用当前流程定义。两者结合意味着：

- 运行中修改画布不会改变当前运行；
- 下一次从阶段重跑会采用新节点、连接、引擎和模型；
- `TaskRunner` 启动时会为当前流程缺失的 `TaskStep` 执行 `get_or_create`；
- 协调助手创建提案前仍要求目标阶段已经存在于任务的 `TaskStep` 投影中。

因此，旧任务刚新增一个阶段后，协调助手可能暂时无法直接把它作为提案目标；经过一次采用当前流程的运行/重跑后，投影会补齐。若产品要支持“新增后立即由协调助手启动”，应在流程保存或提案校验阶段显式同步 TaskStep，而不是依赖一次运行带出。

## 十三、进程重启恢复

daemon 启动时执行两类恢复：

### 运行恢复

- 扫描仍为 `running` 的 `WorkflowRun`；
- 若另一个实例持有新鲜租约，不抢占，等租约过期后重试；
- 将旧的运行中 `StepRun` 标记为失败并丢弃未完成产物轮次；
- 将对应 `TaskStep` 恢复为 `pending`；
- 封存未回答的交互请求和仍在转圈的消息；
- 使用原 `WorkflowRun.workflow_snapshot_json` 从最后完成位置继续。

### 队列恢复

持久化为 `queued` 的任务重新注册到内存并发队列，继续按 FIFO 等待；取消等待会回到 `ready`。

## 十四、状态解释

### Task 状态

| 状态 | 含义 |
|---|---|
| `ready` | 未启动，或本次运行已正常收尾 |
| `queued` | 等待任务并发槽位 |
| `running` | runner 正在执行或恢复调度 |
| `paused` | 失败、审核耗尽、返回上限或路由冲突，需要人工处理 |

### TaskStep 常见状态

| 状态 | 含义 |
|---|---|
| `pending` | 本次尚未执行 |
| `running` | 引擎正在运行 |
| `reviewing` | 自动审核运行中 |
| `awaiting_review` | 等待人工决定 |
| `retrying` | 审核失败后准备重试当前阶段 |
| `rework` / `rework_waiting` | 返回线要求目标或关联阶段重跑 |
| `passed` | 阶段和审核已通过 |
| `failed` | 阶段、审核或路由失败 |
| `cancelled` | 用户停止阶段 |
| `skipped` | 创建范围裁剪，或动态路由本轮没有触发该分支 |

前端只能把真实活动状态显示为“进行中”：`running`、`reviewing`、`awaiting_review`、`retrying`、`rework`、`rework_waiting`。空闲任务中的普通 `pending` 不能伪装成当前运行阶段。

## 十五、实现索引与回归测试

| 主题 | 实现 | 主要测试 |
|---|---|---|
| 创建与起始阶段 | `services/task_creation.py`、`services/task.py` | `tests/test_task.py`、`tests/test_task_draft.py` |
| 流程编译 | `services/workflow_definition.py` | `tests/test_workflow_definition.py` |
| 调度与阶段执行 | `services/task_runner.py`、`services/pipeline.py` | `tests/test_pipeline.py`、`tests/test_workflow_runtime.py` |
| 端口路由 | `services/artifact_routing.py` | `tests/test_artifact_port_routing.py` |
| 产物轮次 | `services/artifact_rounds.py` | `tests/test_artifact_rounds.py` |
| 提示词 | `services/prompt.py` | `tests/test_pipeline.py` |
| 审核 | `services/review_gate.py`、`services/workflow_runtime.py` | `tests/test_review_gate.py`、`tests/test_workflow_runtime.py` |
| 协调助手 | `agent_assistants/coordinator.py` | `tests/test_coordinator.py` |
| 并发与恢复 | `services/concurrency.py`、`services/workflow_runtime.py` | `tests/test_concurrency_gate.py`、`tests/test_recovery.py` |
