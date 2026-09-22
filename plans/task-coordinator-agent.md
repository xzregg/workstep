# 用户消息接入工作流：任务协调 Agent

> 状态：核心链路已实现。协调会话、动作提案、阶段补充、审核决策、指定阶段重跑和阶段消息已接入；本文前半部分保留实施前可行性分析，当前契约以代码、`docs/architecture.md` 和测试为准。

## 1. 结论与可行性

### 1.1 总体结论

方案可行，建议分阶段实施，不建议一次性同时交付协调聊天、实时注入和阶段重跑。

- 协调聊天、结构化动作提案、用户确认、阶段补充、Review 决策：可行性高。
- 支持 resume 的任务级协调会话：可行性中高，需要先补齐统一的 session ID 返回协议。
- 从指定阶段安全重跑：可行性中等，必须同时实现运行血缘、复用步骤记录、任务级并发锁和旧产物归档。
- 工作流执行期间与协调 Agent 并行聊天：可行性高，但同一任务的协调 turn 必须串行或排队。
- 向正在执行的阶段 Agent 实时发送普通消息：首版暂不承诺。只有适配器实现并通过真实集成测试后才开放能力。

### 1.2 建议的首版范围

首版包含：

1. 用户消息默认进入协调 Agent，不再隐式启动 `WorkflowRun`。
2. 协调 Agent 可以回答问题、请求读取受控产物、生成动作提案。
3. 动作提案支持 `supplement_stage`、`rerun_from_stage`、`review_decision`。
4. 所有有副作用的动作必须由用户确认，确认接口事务化且幂等。
5. 工作流执行流和协调回复流通过 `message_id` 完全隔离。
6. 从阶段重跑保留可复用上游结果，并归档受影响阶段的旧产物。

首版不包含：

- 协调 Agent 修改流程连线、阶段 Prompt、阶段引擎或模型。
- 协调 Agent 直接编辑、删除或创建项目文件。
- 未经确认改变任务状态、Review 状态或启动任何执行引擎。
- 没有真实适配器支持时展示 `inject_stage_message` 动作。
- 多个协调 turn 在同一任务中同时调用同一个 session；后续消息只能排队。

### 1.3 当前代码基础与改造难度

| 范围 | 当前基础 | 可行性 | 主要改造 |
|---|---|---|---|
| 聊天入口分离 | 已有 `/api/task/run` 和任务历史 | 高 | 新增聊天接口，停止把输入框消息传给运行接口 |
| 多流消息展示 | 已有 WebSocket 和持久化 Message | 高 | 事件补齐 message ID；前端从按任务累积改为按消息累积 |
| 协调引擎调用 | 已有统一引擎 Adapter 和流式事件 | 中高 | 增加无工具调用策略、结构化结果和 session ID 返回 |
| 动作提案 | 已有 Review 决策接口 | 高 | 增加统一提案表、状态机、幂等确认和过期校验 |
| 阶段补充 | 已有统一阶段 Prompt 组装 | 高 | 增加追加式补充记录，并在 Prompt 组装时读取 |
| 阶段重跑 | 已有 DAG、WorkflowRun、StepRun 和取消能力 | 中 | 增加传递下游、run 血缘、reused StepRun、任务锁和产物归档 |
| 实时阶段消息 | 现有 `inject_response` 仅用于交互响应 | 低 | 需要具体 Adapter 持有活动 session/client 并实现普通消息协议 |

整体改造较大但范围可控。主要复杂度集中在 Phase 1 的消息身份迁移和 Phase 4 的重跑一致性；其余能力可以通过新增深模块局部实现。只读协调聊天可以在不触碰工作流调度核心的情况下先行发布。

### 1.4 实施状态（2026-08-04）

已完成并进入代码：

- Phase 0—4 的核心链路：协调会话、turn、提案、阶段补充、消息序号、运行血缘和迁移。
- 协调 Agent 通过统一 `BaseLLMEngine.spawn_coordinator()` 调用真实引擎，不使用独立写死的模型客户端。
- 任务级协调引擎与模型配置，支持在已安装且声明支持协调模式的引擎间切换；切换只影响后续 turn。
- 普通聊天与显式运行入口分离；执行消息和协调消息按 `channel`、`message_id`、`event_sequence` 隔离。
- 提案确认/取消、幂等键、任务版本过期校验、阶段补充、Review 决策和指定阶段重跑。
- 重跑创建父子运行血缘、复用无关上游步骤、归档受影响产物，并在失败时执行补偿恢复。
- 断点续跑：Daemon 重启（含异常退出与优雅关闭）后，`WorkflowRuntime`
  启动时扫描残留 `running` 的 `WorkflowRun`，把中断的 StepRun 标记为
  interrupted、复用已成功节点并从最后未完成节点继续；优雅关闭停止引擎但
  保留运行状态，下次启动自动恢复。恢复信息写入
  `workflow_runs.recovered_at / recovered_count` 并广播 `run_recovered`
  事件；前端 WebSocket 重连后自动刷新任务列表，运行中的任务显示
  「断点续跑」徽标与详情页恢复提示条。
- 前端协调聊天、引擎/模型选择、独立实时消息和提案确认界面。

尚未作为完成能力承诺：

- Phase 5 向运行中阶段 Agent 实时注入普通消息：机制已落地（
  `BaseLLMEngine.send_live_stage_message()` + `supports_live_stage_message`
  能力 + `TaskRunner` 阶段消息队列 + `POST /api/task/{id}/step/{key}/message`
  + 前端「阶段 Agent / 协调 Agent」目标选择），Claude Code 直连 CLI 已实现
  `--input-format stream-json` 实时输入模式；前端输入区上方支持「插入消息」
  悬浮面板，可对单条消息「加入引导」（`as_guidance=True`，同时实时注入并持久化
  为 `StageSupplement`，后续重跑自动带上）或「删除」，也可把多条插入消息合并
  发送；其余适配器仍为 false，需逐个实现并跑通真实注入集成测试后再开启。
- 所有 CLI Adapter 的原生工具禁用开关；当前统一入口有只读 Prompt 约束，发布前仍需按引擎补齐并验证原生禁用能力。
- Daemon 重启中的协调 turn 恢复，以及完整真实三阶段 E2E；工作流断点续跑已覆盖模块级恢复测试，并接入 Daemon 启动生命周期。

阶段消息语义：只对运行中的阶段生效，消息持久化为 `channel=execution` 用户
消息并实时注入引擎；标记 `as_guidance` 的消息额外保存为 `StageSupplement`
（`source_proposal=NULL`），进入后续阶段 Prompt 的「用户补充输入」段；协调
对话固定走 `channel=coordinator`，两路消息在上下文组装时完全隔离（协调上下文
只读 coordinator 消息，阶段 Prompt 不读任何聊天消息）。

## 2. 目标与角色边界

### 2.1 角色

- 协调 Agent：唯一直接面向用户回复的角色，理解任务、工作流、状态、Review、协调对话和产物索引；通过现有 LLM Engine Adapter 真实调用模型，并可独立切换引擎和模型。
- 阶段 Agent：只执行阶段 Prompt、读取上游产物并生成当前阶段产物。
- Review Agent：只验收一个确定的 `StepRun`，输出结构化审核报告。
- 后端策略层：验证协调 Agent 的结构化输出、读取产物、创建提案并执行用户确认后的动作。

### 2.2 强制不变量

1. 协调 Agent 的文本输出永远不能直接触发副作用。
2. 只有已持久化且状态为 `pending` 的提案可以被确认。
3. 提案执行前必须再次校验它引用的任务版本、`WorkflowRun`、`StepRun` 和 `ReviewRun`。
4. 同一任务最多有一个活动 `WorkflowRun`，最多有一个运行中的协调 turn。
5. DAG 可能同时存在多个活动阶段，不使用唯一“当前阶段”作为业务真相。
6. `TaskStep` 是当前状态投影；运行历史以 `WorkflowRun`、`StepRun`、`ReviewRun` 为准。
7. 新的阶段重跑不得覆盖旧运行的产物而不保留历史。
8. 所有流式事件必须能唯一归属到一个持久化消息。

## 3. 总体架构

新增一个深模块 `CoordinatorModule`，把上下文组装、引擎调用、结构化解析、产物补充读取、消息持久化和提案创建隐藏在一个小接口后面。

建议外部接口只有：

```python
async def submit_message(
    project_id: str,
    task_id: str,
    content: str,
    idempotency_key: str,
) -> ChatAccepted

async def confirm_action(
    project_id: str,
    task_id: str,
    proposal_id: str,
    idempotency_key: str,
) -> ActionExecutionResult

async def cancel_action(
    project_id: str,
    task_id: str,
    proposal_id: str,
) -> ActionProposalView
```

模块内部包含以下实现，不作为调用方接口暴露：

- `CoordinatorContextAssembler`：生成受预算约束的协调上下文。
- `CoordinatorInvoker`：按统一调用策略执行协调引擎并处理 session。
- `CoordinatorOutputParser`：校验 JSON 协议并执行最多一次无状态修复。
- `ArtifactReadService`：通过 `artifact_id` 安全读取文本产物。
- `ActionProposalExecutor`：事务化执行动作并维护状态机。
- `TaskOperationLock`：串行化同一任务上的运行控制和提案确认。

工作流运行与协调聊天使用不同的模块和引擎实例，可以并行；同一任务的协调 turn 按提交顺序串行执行。

## 4. 核心消息流程

### 4.1 接收消息

1. 客户端生成 `idempotency_key` 并调用聊天接口。
2. 后端在一个数据库事务中：
   - 校验任务存在。
   - 分配两个连续的任务消息序号。
   - 创建 `channel=coordinator` 的用户消息。
   - 创建 `channel=coordinator`、`status=queued` 的 assistant 占位消息。
   - 创建 `CoordinatorTurn`，关联两条消息。
3. HTTP 立即返回 turn 和两条消息的 ID。
4. 后端将 turn 放入任务级协调队列。
5. turn 开始时变为 `running`，组装上下文并调用协调引擎。
6. 所有流式事件归属 assistant 消息；文本按节流策略增量落库。
7. 结构化结果通过校验后，保存最终回复和可选提案。
8. turn 与 assistant 消息变为 `succeeded`；失败则保存可展示错误并变为 `failed`。

重复提交相同 `idempotency_key` 时返回原有 `ChatAccepted`，不得创建重复消息或重复调用引擎。

### 4.2 上下文组装

上下文按以下优先级组装，并受统一 token/字节预算控制：

1. 协调系统规则和结构化输出协议。
2. 任务标题、说明、状态、状态版本和当前活动 run。
3. 工作流快照：节点、依赖、条件、Prompt、引擎、模型、Review 配置。
4. 每个阶段的当前投影状态以及活动阶段列表 `active_step_keys[]`。
5. 当前未决 Review，精确到 `ReviewRun.id` 和 `StepRun.id`。
6. 已确认的阶段补充索引。
7. 产物索引，仅包含 `artifact_id`、阶段、逻辑名、相对路径、类型、大小、来源 run。
8. 协调会话摘要。
9. 最近协调消息，默认最多 20 条，同时受 token 预算约束。

不把单个 `step_key` 当作唯一当前阶段。协调消息可保存一个可空的 `context_step_key` 作为界面提示，但动作目标必须由结构化提案显式给出。

默认上下文预算建议为 32K tokens；超过预算时依次裁剪旧消息、非活动 Review 详情、历史产物和非活动阶段的完整 Prompt。必须保留工作流拓扑、任务状态、活动阶段和当前未决 Review。

### 4.3 结构化输出协议

协调引擎输出固定 JSON：

```json
{
  "version": 1,
  "reply": "给用户的自然语言回复",
  "intent": "answer | clarify | propose_action",
  "target_step_key": null,
  "artifact_requests": ["artifact-id"],
  "proposal": null
}
```

`proposal` 使用按 `type` 区分的严格联合类型，只允许服务端注册的动作和字段。未知字段、未知动作、无效阶段、过期 Review 或超限产物请求均拒绝。

若首次结果请求产物正文：

1. 只接受本轮上下文中已经提供的 `artifact_id`。
2. 后端读取最多 5 个文本文件，单文件最多 64KB，总计最多 192KB。
3. 将读取结果作为不可信数据块加入第二次推理。
4. 第二次推理不得继续请求更多文件。

若 JSON 解析失败，只允许一次无状态修复调用。修复调用不复用协调 session，避免把格式修复污染为新的对话 turn；再次失败则 turn 失败，不创建提案。

## 5. 引擎接口调整

### 5.1 协调引擎选择与切换

协调 Agent 不绑定固定厂商或固定实现，必须复用现有 Engine Registry 和 `BaseLLMEngine` Adapter。Claude、Codex、Hermes、QCode、OpenClaw、API、ACP 等引擎只要已安装并满足协调模式能力要求，就可以成为协调引擎。

强制规则：

1. 协调引擎与工作流阶段引擎完全独立；切换协调引擎不得修改任何阶段的 engine/model。
2. 可选项来自 Engine Registry 的实时发现结果，不在协调模块中硬编码引擎列表。
3. 只有 `installed=true` 且 `supports_coordinator=true` 的 Adapter 可以被选择。
4. `supports_coordinator` 至少要求：能够返回文本流、能够可靠禁用工具、能够完成结构化输出解析；支持 resume 不是必选条件。
5. 每个 `CoordinatorTurn` 在创建时固化 engine/model。配置切换只影响配置提交后新创建的 turn，不改变正在运行或已经排队的 turn。
6. 切换 engine 或 model 后结束旧协调 session；下一条消息使用新 Adapter 创建新 session。协调 transcript 和摘要继续保留，因此切换引擎不会丢失任务对话上下文。
7. 用户明确选择的引擎后来不可用时不得静默切到其他引擎；本次 turn 返回可恢复的配置错误，并要求用户重新选择或恢复默认配置。
8. 没有任务级配置时才按“全局协调默认引擎 → 全局默认引擎”回退。

建议 Engine Registry 对外增加：

```python
@dataclass(frozen=True)
class EngineCapabilities:
    supports_coordinator: bool
    supports_resume: bool
    supports_tool_disable: bool
    supports_native_schema: bool
    supports_live_stage_message: bool
```

`CoordinatorInvoker` 只依赖统一 Adapter 接口，不按引擎名称写分支。引擎之间的 CLI、ACP、HTTP、session 和 schema 差异全部留在各自 Adapter 的实现内部。

### 5.2 调用策略

现有 `spawn()` 接口无法强制“无工具”。新增统一调用选项：

```python
@dataclass(frozen=True)
class EngineInvocationOptions:
    tools: Literal["enabled", "disabled"]
    output_schema: dict | None = None
    session_id: str | None = None
```

协调调用必须使用 `tools="disabled"`。适配器如果不能可靠禁用工具，应声明不支持协调模式，不能只依靠 Prompt 声明“不要使用工具”。

### 5.3 能力声明

能力至少拆分为：

- `supports_resume`
- `supports_tool_disable`
- `supports_native_schema`
- `supports_live_stage_message`

现有 `inject_response(tool_use_id, content)` 仅表示权限或工具交互响应，不能作为普通阶段消息注入。

只有适配器真正实现 `send_live_stage_message()`，并通过运行中消息注入的集成测试后，才返回 `supports_live_stage_message=true`。首版默认所有现有适配器为 false。

### 5.4 Session 生命周期

- 引擎在新建会话后必须通过统一 `session_started` 事件或调用结果返回 session ID。
- 每个任务只有一条协调 session 记录。
- 同一 session 的调用严格串行。
- 切换协调 engine 或 model 时关闭旧 session，保留 transcript 与摘要，并创建新 session。
- resume 失败时允许降级为 transcript 重建，但要记录降级原因。
- 不支持 resume 的引擎每次使用摘要与近期 transcript 重建上下文。

摘要必须记录 `summary_through_sequence`，只总结该序号及之前的协调消息。生成新摘要后仍保留最近若干原始消息，避免摘要漂移。

## 6. 数据模型与迁移

### 6.1 `tasks`

新增：

- `coordinator_engine` nullable
- `coordinator_model` nullable
- `active_workflow_run_id` nullable
- `state_version` integer，默认 0，每次运行控制或 Review 状态变化后递增
- `next_message_sequence` integer，默认 1

协调引擎优先级：任务配置 → 全局协调默认引擎 → 全局默认引擎。模型优先级：任务协调模型 → 对应引擎默认模型 → 适配器默认模型。

任务级 coordinator engine/model 是协调 Agent 的独立配置，不复用 `Task.engine`，也不跟随活动阶段变化。每个 `CoordinatorTurn` 必须保存最终解析出的 engine/model，确保历史记录和费用统计可追溯。

### 6.2 `messages`

新增：

- `channel`: `coordinator | execution | review`
- `sequence`: 任务内严格递增
- `reply_to_message_id` nullable
- `context_step_key` nullable

流式事件仍可以保存在 `events_json`，但 assistant 的 `content` 必须定时增量写入，避免进程崩溃后丢失全部可见输出。

迁移规则：

- 旧 `role=review` 迁移为 `role=assistant, channel=review`。
- 其他旧消息迁移为 `channel=execution`。
- 按 `created_at, id` 为每个任务回填 `sequence`。
- 新增唯一索引 `(task_id, sequence)` 和查询索引 `(task_id, channel, sequence)`。

### 6.3 `coordinator_sessions`

- `task_id` unique
- `engine`
- `model`
- `session_id` nullable
- `summary` nullable
- `summary_through_sequence` nullable
- `version`
- `status`: `active | reset | failed`
- `last_error` nullable
- `created_at`
- `updated_at`

### 6.4 `coordinator_turns`

- `id`
- `task_id`
- `user_message_id`
- `assistant_message_id`
- `idempotency_key`
- `status`: `queued | running | succeeded | failed | cancelled`
- `engine`
- `model`
- `session_id` nullable
- `requested_artifact_ids_json` nullable
- `error` nullable
- `started_at`
- `ended_at`
- `created_at`

唯一索引 `(task_id, idempotency_key)`。

### 6.5 `action_proposals`

- `id`
- `task_id`
- `source_turn_id`
- `source_message_id`
- `type`
- `target_step_key` nullable
- `payload_json`
- `impact_json`
- `expected_task_version`
- `expected_workflow_run_id` nullable
- `expected_step_run_id` nullable
- `expected_review_run_id` nullable
- `status`: `pending | executing | succeeded | failed | cancelled | expired`
- `confirm_idempotency_key` nullable
- `confirmed_at` nullable
- `executed_at` nullable
- `result_json` nullable
- `error` nullable
- `created_at`
- `updated_at`

确认通过事务内 compare-and-set 将 `pending` 改为 `executing`。重复使用同一确认幂等键返回原执行结果；不同动作或不同 payload 不得复用幂等键。

### 6.6 `stage_supplements`

阶段补充使用追加式记录，不直接覆盖 `task_steps`：

- `id`
- `task_id`
- `step_key`
- `content`
- `source_proposal_id`
- `created_sequence`
- `active`，默认 true
- `created_at`

所有确认后的 active 补充按 `created_sequence` 加入该阶段后续 attempt 的 Prompt。首版不提供编辑；后续可通过新提案停用旧补充。

### 6.7 运行血缘

`workflow_runs` 新增：

- `parent_run_id` nullable
- `restart_from_step_key` nullable
- 状态补充 `cancelled | superseded`

`step_runs` 新增：

- `source_step_run_id` nullable
- 状态补充 `reused | cancelled`

新 run 中复用的步骤创建 `status=reused` 的 `StepRun`，指向来源 `StepRun`。调度器将 `succeeded` 且 Review 通过的步骤、以及 `reused` 步骤视为已完成。

## 7. 动作语义

### 7.1 `supplement_stage`

确认前：只保存提案。

确认后：

1. 校验目标阶段仍存在。
2. 创建 `StageSupplement`。
3. 不修改当前运行状态，不自动启动或重跑阶段。
4. 如果阶段正在运行，回复中明确说明补充只影响下一次 attempt。
5. 可额外生成一个新的 `rerun_from_stage` 提案，但不能自动确认。

### 7.2 `review_decision`

payload 必须包含精确的 `review_run_id`、决策和可选 comment。

确认时：

1. 校验它仍是目标阶段最新的未决 Review。
2. 校验 `expected_task_version` 和 `expected_workflow_run_id`。
3. 复用现有 approve/reject/force-approve 逻辑。
4. 相同决策的重复确认返回原结果；不同决策返回冲突。
5. 状态变化或出现更新 Review 时，将提案标记为 `expired`。

### 7.3 `rerun_from_stage`

协调 Agent 根据任务状态和用户反馈选择一个起始阶段；后端执行该阶段及其所有
DAG 下游阶段。提案的 `payload.content` 为可选字段：协调 Agent 判断目标阶段需要
新的 bug 描述、验证要求或修复约束时携带该字段，用户确认后后端幂等创建
`StageSupplement`，并将相同内容注入本轮阶段执行；不需要新上下文时省略该字段。
确认卡必须展示将注入的完整内容。

使用当前活动 run 的不可变工作流快照，而不是项目中后来修改的流程定义。

受影响集合：目标阶段加所有传递下游阶段。需要在 DAG 中新增 `get_all_downstream(step_key)`。

确认执行：

1. 获取任务级运行控制锁。
2. 校验任务版本、活动 run、目标阶段和工作流快照。
3. 计算受影响阶段、可复用步骤和当前运行阶段。
4. 若当前 run 仍在执行，停止整个 Runner 并等待完全退出。首版不在活动调度器中原地改写 DAG。
5. 当前正在运行但不在受影响集合中的并行阶段也会被中断；它们进入新 run 重新执行，并必须在确认卡中展示。
6. 将旧 run 标记为 `superseded`，把中断的 `StepRun` 标记为 `cancelled`。
7. 归档受影响阶段和被中断阶段的当前产物目录。
8. 创建新 `WorkflowRun`，设置 `parent_run_id` 和 `restart_from_step_key`。
9. 对所有已通过且不需要重新执行的步骤创建 `reused StepRun`。
10. 将需要执行的 `TaskStep` 投影重置为 `pending`，清除错误和时间；保留可复用步骤的 passed 状态。
11. 更新 `active_workflow_run_id` 和 `state_version`。
12. 提交事务后启动新 run；启动失败时将任务置为 stopped，并保留可重试错误。

产物归档目录建议：

```text
.workstep/artifact-history/<task_id>/<workflow_run_id>/<step_key>/
```

归档采用同一文件系统内的 rename。数据库事务失败时必须执行补偿恢复；不能在旧目录未归档时启动新阶段，否则新旧产物会混合。

### 7.4 `inject_stage_message`

首版默认不注册此动作。后续开放条件：

1. 至少一个具体适配器实现普通消息注入，而不是权限响应。
2. 可以精确定位活动 `StepRun` 和引擎实例。
3. 注入调用有成功/失败回执。
4. 通过真实引擎集成测试，证明不会启动第二个 turn、不会丢失原输出。

不支持时，协调 Agent 只能提出 `supplement_stage` 或 `rerun_from_stage`，不能先创建一个必然失败的注入提案。

## 8. 产物读取安全

- 模型只能请求上下文中列出的 `artifact_id`，不能提交任意路径。
- `artifact_id` 在服务端映射到项目、任务、阶段和来源 run。
- resolve 后路径必须位于允许的产物根目录内。
- 拒绝符号链接、目录、设备文件和路径穿越。
- 首版只读取 UTF-8 或可安全检测编码的文本类型；二进制产物只返回元数据。
- 单文件 64KB、最多 5 个文件、总计 192KB；限制在读取前和读取过程中都执行。
- 产物内容使用明确的不可信数据标记包裹，不能改变系统规则或动作白名单。
- 记录 turn 实际读取的 artifact ID、大小和结果，便于审计。

## 9. HTTP 与事件接口

### 9.1 聊天

```http
POST /api/task/{task_id}/chat?project_id=...
Idempotency-Key: <uuid>

{
  "content": "用户消息"
}
```

```json
{
  "turn_id": "...",
  "user_message_id": "...",
  "assistant_message_id": "...",
  "status": "queued"
}
```

### 9.2 提案

```http
POST /api/task/{task_id}/actions/{proposal_id}/confirm?project_id=...
Idempotency-Key: <uuid>
```

```http
POST /api/task/{task_id}/actions/{proposal_id}/cancel?project_id=...
```

历史接口返回消息时内嵌关联提案的只读视图；刷新后确认卡仍可恢复。

### 9.3 协调配置

```http
GET   /api/task/{task_id}/coordinator-config?project_id=...
PATCH /api/task/{task_id}/coordinator-config?project_id=...
```

PATCH 请求：

```json
{
  "engine": "codex",
  "model": "可空的模型 ID"
}
```

传入 `engine=null, model=null` 表示恢复全局协调默认配置。后端必须通过 Engine Registry 校验引擎已安装、支持协调模式，并通过该 Adapter 的模型列表校验 model；不能保存一个已知不可用的组合。

GET 响应同时返回任务配置、最终生效配置和可切换引擎摘要：

```json
{
  "configured": {"engine": "codex", "model": null},
  "resolved": {"engine": "codex", "model": "default"},
  "available_engines": [
    {"id": "claude", "supports_coordinator": true},
    {"id": "codex", "supports_coordinator": true}
  ]
}
```

全局设置新增默认协调 engine/model。任务配置变更不影响已运行或已排队的 turn，只影响配置提交后创建的 turn。

### 9.4 事件信封

所有工作流、Review 和协调事件统一携带：

```json
{
  "event_id": "uuid",
  "task_id": "...",
  "channel": "coordinator | execution | review",
  "message_id": "...",
  "step_key": null,
  "event_sequence": 1,
  "type": "text_delta",
  "data": {},
  "created_at": "..."
}
```

每条消息内的 `event_sequence` 严格递增。执行阶段必须先创建 assistant 消息，再发送任何属于该消息的状态或文本事件。

## 10. 前端调整

- 任务详情输入框只在“协调 turn 正在处理”时禁用或显示排队状态，不再因工作流运行而禁用。
- 对话区头部增加协调引擎和模型选择器，数据来自 Engine Registry；只展示已安装且支持协调模式的引擎。
- 切换引擎时明确提示“从下一条协调消息生效”，并显示当前 turn 实际使用的 engine/model。
- 协调引擎选择器与阶段引擎配置分开，不能让用户误以为会改变工作流节点配置。
- 引擎切换失败时恢复原选择并显示后端错误，不做静默回退。
- “开始任务”和“发送消息”使用独立按钮和独立接口。
- 消息历史按任务 `sequence` 展示，不再按阶段重新分组打乱时间顺序。
- 每条消息显示 channel 标识和可选阶段标签。
- Store 改为 `liveMessagesById`，每个 `message_id` 独立维护文本、事件、usage 和状态。
- 收到未知 `message_id` 的事件时先创建临时占位，再通过历史接口校准。
- HTTP 返回后用真实 user/assistant ID 替换 optimistic 记录；事件先于 HTTP 响应到达时也能合并。
- 动作提案显示动作类型、目标阶段、引用的 run/review、完整影响范围及确认/取消按钮。
- 确认中禁止重复点击；失败后保留卡片和错误，只有仍为 `pending` 或可安全重试时显示重试。
- Review 原有快捷按钮保留，但与协调提案共用同一个后端决策模块。

## 11. 并发、恢复与错误处理

- `TaskOperationLock` 以 `project_id + task_id` 为键，覆盖启动、取消、Review 决策、重跑和提案确认。
- HTTP 幂等键解决客户端重试；数据库 compare-and-set 解决并发确认。
- 协调队列以任务为粒度串行，同一项目不同任务可以并行。
- Daemon 重启时将遗留的 `running` CoordinatorTurn 标记为 failed；用户可重新发送，不自动重放可能产生费用的引擎调用。
- 遗留 `executing` 提案启动恢复检查：若结果已经落库则补齐 succeeded，否则根据动作类型安全重试或标记 failed，禁止盲目重复执行。
- WebSocket 不是唯一事实来源；断线重连后以消息历史和提案表恢复。
- EventBus 丢事件不应导致数据库状态错误，最终状态必须在持久化记录中可查询。

## 12. 实施顺序

### Phase 0：契约和迁移

- 固定消息事件信封、协调 JSON schema、动作联合类型和状态机。
- 增加模型与幂等迁移，完成旧消息回填。
- 增加任务状态版本和任务级操作锁。
- 增加功能开关 `coordinator_chat_enabled`，默认关闭。

验收门槛：迁移可对已有项目数据库重复执行；关闭开关时现有任务运行行为不变。

### Phase 1：多消息流与前端时间线

- 所有执行和 Review 事件补齐 `channel`、`message_id`、`event_sequence`。
- 前端 Store 改为按 `message_id` 累积。
- 历史按任务 sequence 展示并支持刷新恢复。
- 保留 `/api/task/run` 作为显式启动接口。

验收门槛：并行 DAG 的两个阶段同时输出时不串内容、不覆盖 usage。

### Phase 2：只读协调聊天

- 实现 `CoordinatorModule.submit_message()`。
- 实现任务级协调队列、session、上下文预算、无工具策略和结构化解析。
- 实现安全产物读取与第二次推理。
- 此阶段协调 Agent 只能回答，不能创建可执行提案。

验收门槛：普通问题不会创建 `WorkflowRun`、`StepRun`、提案或产物变化。

### Phase 3：提案、补充和 Review

- 实现提案状态机和确认接口。
- 实现 `supplement_stage` 和 Prompt 注入。
- 接入 `review_decision`，复用现有 Review 决策模块。
- 前端显示可恢复的确认卡。

验收门槛：未确认动作无副作用；重复确认和过期提案行为稳定。

### Phase 4：安全阶段重跑

- 增加 DAG 传递下游计算。
- 实现运行血缘、reused StepRun、任务级停止与重启。
- 实现受影响产物归档和补偿恢复。
- 实现重跑影响预览。

验收门槛：旧 run、旧 Review 和旧产物都可追溯，新 run 只执行受影响及被中断步骤。

### Phase 5：可选实时注入

- 只为已验证的适配器实现并开放 `supports_live_stage_message`。
- 未安装或不支持的适配器不显示该动作。

验收门槛：真实引擎运行中注入 E2E 通过，否则该阶段不发布。

## 13. 测试计划

### 13.1 消息与协调 turn

- 普通消息只创建两条协调消息和一个 turn，不创建 run 或产物。
- 相同聊天幂等键不重复调用引擎。
- 同一任务连续发送两条消息时严格排队，不并发 resume 同一 session。
- 不同任务协调 turn 可以并行。
- 事件先于 HTTP 响应到达时前端正确合并。
- 两个执行阶段和一个协调回复同时流式输出时互不覆盖。
- 刷新后消息顺序、channel、内容、usage 和提案一致。
- Daemon 在 turn 中途退出后，重启可展示失败状态和已持久化文本。

### 13.2 上下文与产物安全

- 并行 DAG 上下文包含多个 `active_step_keys`，不伪造唯一当前阶段。
- 上下文预算裁剪后仍保留拓扑、活动阶段和未决 Review。
- 目录穿越、符号链接、二进制文件、未知 artifact ID 和超限读取全部拒绝。
- 产物中的提示注入不能绕过动作白名单或用户确认。
- 第二次推理不能继续请求文件。

### 13.3 Session 与引擎

- 至少使用两个 Fake Adapter 验证协调 Agent 能在不同引擎之间切换，且调用均经过统一 Engine Registry/Adapter seam。
- 切换协调引擎不改变任务阶段的 engine/model，也不中断正在执行的工作流。
- 正在运行和已经排队的 turn 保持创建时固化的 engine/model；切换后新 turn 使用新引擎。
- 切换后旧 transcript 和摘要进入新引擎上下文，但不复用不兼容的 session ID。
- 用户明确配置的引擎不可用时返回配置错误，不静默使用全局默认引擎。
- 引擎与模型组合由对应 Adapter 校验，无效 model 不能保存。
- 支持 resume 的协调适配器保存并复用 session ID。
- session ID 缺失或 resume 失败时正确降级 transcript。
- 不支持 resume 的引擎使用摘要和近期消息重建。
- 切换协调 engine/model 后新建 session，旧 transcript 仍可用于上下文。
- 不支持可靠禁用工具的引擎不能配置为协调引擎。
- 协调 Agent 支持图片理解（多模态）模型配置：全局默认与任务级均可设置
  `vision_model`，任务级优先；解析结果进入协调上下文
  `coordinator_vision_model`，供主模型不支持图片输入时分析图片和截图。
- 引擎统一 seam（`BaseLLMEngine.spawn` / `spawn_coordinator`）支持
  `images` 图片入参（本地路径 / http(s) URL），并新增
  `supports_vision` 能力位：API 直调与 PydanticAI 以原生图片内容块/部件
  发送，Claude Code / Claude Agent SDK 以 markdown 图片引用读取，其余引擎
  把图片引用注入 prompt 降级处理（模型不支持时至少可见路径）。
- 协调用户消息中的图片（Markdown 图片引用，目标为
  `项目名/.workstep/uploads/...`，或裸
  `.workstep/uploads/...` 路径）会被解析并路由到引擎；仅接受项目
  uploads 目录内的文件，其余路径忽略。
- JSON 解析失败只修复一次，失败后不创建提案。

### 13.4 提案与并发

- 未确认的 supplement、rerun 和 Review 提案没有副作用。
- 两个客户端同时确认同一提案时只执行一次。
- 相同确认幂等键返回同一结果。
- 任务状态版本、活动 run 或 Review 变化后旧提案变为 expired。
- 确认失败保留错误且不会处于永久 executing。
- 取消后的提案不能确认。

### 13.5 阶段补充

- 补充只进入目标阶段后续 attempt 的 Prompt。
- 并行阶段不会收到彼此的补充。
- 多条补充按创建顺序加入 Prompt。
- 当前运行阶段确认补充后不发生实时注入，也不改变本次 attempt。

### 13.6 Review

- approve、reject、force-approve 与现有行为一致。
- 重复相同决定幂等，不同决定冲突。
- 过期 Review、错误阶段和错误 run 不能执行。
- 通过 Review 后只恢复正确 run 的下游调度。

### 13.7 重跑与产物

- 线性流程从中间阶段重跑只复用上游，执行目标和下游。
- DAG 分支重跑只影响目标传递下游；已完成且无关的兄弟分支被复用。
- 运行中的兄弟分支被停止后，在新 run 中重新执行，并出现在确认影响范围。
- 条件分支使用新 run 中的步骤结果重新求值。
- 新 run 使用父 run 的工作流快照，不使用后来编辑的流程。
- 旧 run 标记 superseded，新 run 记录 parent_run_id。
- reused StepRun 正确指向来源 StepRun。
- 旧产物归档，新产物目录为空开始，不混入旧文件。
- 归档后数据库事务失败时目录能恢复。
- 新 run 启动失败时任务进入可理解、可重试的 stopped 状态。

### 13.8 真实 E2E

三阶段流程完成：

1. 第一阶段运行中发送问题。
2. 协调 Agent 并行回答，执行流不受影响。
3. 用户确认目标阶段补充。
4. 用户确认从当前阶段重跑。
5. 旧产物归档，新 run 生成并复用正确上游。
6. Review 提案确认通过。
7. 下游继续并完成。
8. 刷新页面后消息、提案、run 血缘和产物历史一致。

## 14. 风险与缓解

### 高风险

- 重跑覆盖旧产物：通过归档、运行血缘和空目录启动解决。
- 重跑与 Review/取消竞争：通过任务级锁、状态版本和 compare-and-set 解决。
- 协调引擎意外使用工具：通过适配器级禁用能力解决；无法保证则禁止配置。
- 并行流串消息：通过持久化 message ID 和消息内事件序号解决。

### 中风险

- session 恢复协议在各引擎间不一致：统一 `session_started` 和降级 transcript。
- 完整流程 Prompt 导致上下文过大：使用优先级明确的 token 预算。
- SQLite 写竞争：保持事务短小，流式内容节流写入，任务操作串行化。
- WebSocket 丢事件：数据库作为事实来源，重连后拉取历史。

### 暂缓风险

- 普通消息实时注入正在执行的 Agent：没有成熟适配器前不进入首版范围。

## 15. 发布与回滚

- 使用全局功能开关逐步启用协调聊天。
- 先对新任务启用，再允许已有任务使用；迁移本身必须向后兼容。
- `/api/task/run` 始终保留为显式启动入口，不让聊天接口隐式调用。
- Phase 2 可单独发布为只读协调聊天；Phase 3、Phase 4 分别独立启用动作提案和重跑。
- 关闭功能开关后停止接收新协调 turn，但保留历史消息和提案只读展示。
- 数据迁移不在回滚时删除新表或新列，避免历史丢失。

## 16. 最终验收标准

满足以下条件才视为方案完整交付：

1. 普通用户消息不再隐式创建工作流运行。
2. 工作流执行期间可以与协调 Agent 对话，所有流按消息隔离。
3. 协调 Agent 无法直接修改状态、文件、产物或启动引擎。
4. 每个有副作用的动作都能展示完整影响，并且只在用户确认后执行一次。
5. 并行 DAG、Review 和阶段重跑在竞争条件下保持状态一致。
6. 重跑不会丢失或静默覆盖旧产物，运行血缘可追溯。
7. Daemon 重启、WebSocket 断线和页面刷新后都能从数据库恢复正确状态。
8. 真实三阶段 E2E 和全部迁移测试通过。
9. 用户可以在至少两个已安装且支持协调模式的 LLM Engine 之间切换；切换只影响后续协调消息，不影响工作流阶段引擎。

## 17. WorkStep 内部工具（接口抽象为 CLI / 内部 Tool）

把 daemon 内置接口抽象成 Agent 可按需加载的内部工具与 CLI，让 Agent 助手
辅助使用 WorkStep 系统本身。

### 17.1 范围与设计

- 工具注册表：`apps/daemon/services/tool_registry.py` 定义 `WorkstepTool`
  （operation、描述、HTTP method/path、参数 JSON schema、`read_only`、
  副作用说明），首版开放 7 个工具，全部映射现有 REST 端点：
  - 只读：`workstep_list_projects`、`workstep_get_project`、
    `workstep_list_tasks`、`workstep_get_task`、`workstep_list_engines`。
  - 有副作用（创建类）：`workstep_create_project`、`workstep_create_task`，
    参数 schema 强制 `confirm='yes'`。
- `WorkstepClient.call(operation, arguments)`：httpx 异步调用本地 daemon
  （默认 `http://127.0.0.1:8765`，支持 `WORKSTEP_DAEMON_URL` 覆盖），成功
  返回响应 JSON，失败返回结构化 `{"ok": False, "error": ...}`。
- CLI：`apps/daemon/cli.py`（argparse，无新依赖，`uv run workstep ...`），
  `project list/init`、`task list/get/create`、`engine list`，统一 JSON 输出，
  与工具共用同一个 HTTP 客户端。
- 助手按需加载（配置在助手层，不在引擎层）：`AssistantConfig.workstep_tools`
  默认 False，任务协调 Agent（`task_coordinator`）与任务创建助手（
  `task_create`）声明为 True。加载 = 请求引擎**原生注册**内嵌工具
  `workstep_call(operation, arguments)`，docstring 即接口文档与使用约束
  （只读可直接用；创建类必须 `confirm='yes'` 且仅当用户明确要求副作用）；
  **提示词不注入任何工具文档**，模型从工具 schema 感知能力。
  `EngineCapabilities.supports_workstep_tools` 只是传输机制能力位（默认
  False，PydanticAI 引擎开启）：是否把原生工具挂进本轮 turn 由助手传来的
  `workstep_tools` 标志决定，PydanticAI 在 `spawn(..., workstep_tools=True)`
  时注册该工具。未声明该配置的助手（普通聊天、AI 流程助手等）即使使用
  PydanticAI 引擎也不会加载 workstep 工具；无此能力的引擎
  （Claude/Codex/API/ACP）不注册、提示词不变。
- 不开放运行控制类接口（run/pause/cancel/archive）——需异步
  `WorkflowRuntime`，列为后续扩展；删除/重命名等高风险接口不开放。
