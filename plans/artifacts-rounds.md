# 产物轮次目录方案

## 1. 背景

当前产物目录只到阶段：

```text
.workstep/artifacts/<工作流>/<任务>/<阶段>/
```

阶段重跑、审核自动重试、从阶段重新执行时，如果继续写同一个目录，就会覆盖上一轮产物。
这会让用户无法在“改了几次”之后明确说“沿用第 2 轮产物”，也会让下游阶段和协调
Agent 难以稳定定位历史结果。

目标是在阶段下增加轮次：

```text
.workstep/artifacts/<工作流>/<任务>/<阶段>/<轮数>/
```

例如：

```text
.workstep/artifacts/development/task-123/req/1/prd.md
.workstep/artifacts/development/task-123/req/1/manifest.json
.workstep/artifacts/development/task-123/req/2/prd.md
```

这样每个阶段每次真实执行都保留一轮产物，下游默认读取最新成功轮；用户明确要求时，
也可以指定沿用历史某轮。LLM 只需要读取稳定目录和 manifest，不需要理解 Git commit、
分支或 diff。

## 2. 结论

第一版采用“目录轮次 + manifest”作为产物历史主机制。

不建议把项目业务仓库的 Git 作为第一版主机制，原因如下：

- 项目初始化会把整个 `.workstep/` 写入 `.gitignore` 和 `.dockerignore`，
  见 [project.py](/Users/xzr/Desktop/workstep/apps/daemon/services/project.py:649)。
  默认情况下，WorkStep 产物不会进入用户业务仓库历史。
- Git 擅长文件版本工具能力，但不直接表达 WorkStep 需要的业务语义：
  第几轮、是否审核通过、哪个轮次可被下游继承、当前阶段实际用了哪些上游轮次。
- LLM 直接读 `.../<阶段>/<轮数>/manifest.json` 比让它计算 Git ref、commit 或
  worktree 更快、更可靠。

Git 后续可以作为可选增强，例如为任务产物建内部仓库或提供导出/diff 能力，但不能替代
轮次目录、manifest 和 `input_rounds`。

## 3. 术语与语义

### 3.1 轮数

`轮数` 定义为“任务 + 阶段”的全局执行轮次，从 1 开始递增。

不要复用现有 `task.run_round`。当前 `task.run_round` 是 `WorkflowRun` 父子链深度，
见 [task.py](/Users/xzr/Desktop/workstep/apps/daemon/services/task.py:614)，和产物轮次语义不同。

### 3.2 何时产生新轮

每次阶段真正启动执行引擎时分配一个新轮，包括：

- 首次执行；
- 审核不通过后的自动重跑；
- 用户从某阶段重新执行；
- daemon 恢复后重新调度中断阶段；
- follow-up 触发阶段重新执行（如果该 follow-up 实际启动了一次新的阶段执行）。

失败、取消、驳回、成功都保留对应轮次目录。是否可被下游继承由阶段最终状态决定，
不是由目录是否存在决定。

### 3.3 可继承轮

下游默认可继承的轮次必须满足：

- 该轮有 manifest；
- 该轮对应的 `StepRun` 已结束；
- 阶段最终状态为 `passed`。

`passed` 包括审核通过、跳过审核、以及旧流程的“执行成功即通过”兼容路径。
`awaiting_review`、`retrying`、`rejected`、`failed`、`cancelled` 的轮次不可作为默认输入。

### 3.4 下游默认选择

阶段 Prompt 默认注入每个依赖阶段的最新可继承轮。

如果依赖阶段没有可继承轮，则本轮不注入该依赖的“已完成产物引用”，但仍保留依赖检查，
由 DAG 调度保证不会在依赖未通过时启动。

### 3.5 显式沿用历史轮

用户可以在协调 Agent 中说“沿用 req 第 2 轮产物”。该选择必须由后端或协调 Agent 解析成
结构化输入，不能只靠执行阶段模型自己猜路径。

推荐 payload：

```json
{
  "type": "rerun_from_stage",
  "target_step_key": "dev",
  "payload": {
    "input_rounds": {
      "req": 2
    }
  }
}
```

该输入写入被重跑阶段的 `StepRun.input_rounds_json`，并在 Prompt 中明确展示。

## 4. 当前实现核验

### 4.1 已有骨架

- Prompt 已声明产物目录为 `.workstep/artifacts/<工作流>/<任务>/<阶段>/`：
  [prompt.py](/Users/xzr/Desktop/workstep/apps/daemon/services/prompt.py:19)。
- 产物列表已按“工作流 / 任务 / 阶段”扫描并读取阶段根目录下的 `manifest.json`：
  [artifacts.py](/Users/xzr/Desktop/workstep/apps/daemon/services/artifacts.py:7)。
- `StepRun.attempt` 已表示某个 `WorkflowRun` 内该阶段第几次执行：
  [run.py](/Users/xzr/Desktop/workstep/apps/daemon/models/run.py:34)。
- 审核 Prompt 当前扫描阶段根目录：
  [review_gate.py](/Users/xzr/Desktop/workstep/apps/daemon/services/review_gate.py:231)。
- 协调 Agent 的 artifact index 当前按阶段根目录生成 ID：
  [coordinator.py](/Users/xzr/Desktop/workstep/apps/daemon/agent_assistants/coordinator.py:1766)。

### 4.2 关键冲突

阶段重跑归档仍使用旧路径：

```text
.workstep/artifacts/<阶段>/<任务>/
```

见 [workflow_runtime.py](/Users/xzr/Desktop/workstep/apps/daemon/services/workflow_runtime.py:1603)。
这和 Prompt、产物列表、协调 Agent 使用的路径不一致。

新方案必须收敛到唯一路径：

```text
.workstep/artifacts/<工作流>/<任务>/<阶段>/<轮数>/
```

重跑不再把旧阶段目录移动到 `.workstep/artifact-history/`，而是保留旧轮并直接写新轮。

## 5. 统一路径模块

新增一个后端产物路径模块，例如：

```text
apps/daemon/services/artifact_rounds.py
```

职责保持小而集中：

- 生成工作流、任务、阶段、轮次目录：
  `workflow_step_round_dir(artifacts_root, workflow_id, task_id, step_key, round)`；
- 生成 manifest 路径；
- 识别 legacy 阶段根目录；
- 枚举某阶段的轮次；
- 读取 manifest 并校验文件路径不逃逸；
- 解析并校验 `input_rounds`；
- 选择“最新可继承轮”；
- 为 API 和协调 Agent 生成统一的 artifact metadata。

调用方至少包括：

- [prompt.py](/Users/xzr/Desktop/workstep/apps/daemon/services/prompt.py:136)
- [artifacts.py](/Users/xzr/Desktop/workstep/apps/daemon/services/artifacts.py:7)
- [review_gate.py](/Users/xzr/Desktop/workstep/apps/daemon/services/review_gate.py:231)
- [task_runner.py](/Users/xzr/Desktop/workstep/apps/daemon/services/task_runner.py:697)
- [workflow_runtime.py](/Users/xzr/Desktop/workstep/apps/daemon/services/workflow_runtime.py:1306)
- [coordinator.py](/Users/xzr/Desktop/workstep/apps/daemon/agent_assistants/coordinator.py:1766)
- [task_dispatch.py](/Users/xzr/Desktop/workstep/apps/daemon/services/task_dispatch.py:36)

## 6. 数据模型

### 6.1 `StepRun`

给 `StepRun` 增加：

```sql
artifact_round INTEGER
input_rounds_json TEXT
```

字段语义：

| 字段 | 说明 |
|---|---|
| `attempt` | 保留现状：某个 `WorkflowRun` 内该阶段第几次 `StepRun` |
| `artifact_round` | 任务 + 阶段维度的产物轮次；未执行/legacy 可为空 |
| `input_rounds_json` | 本轮流实际选择的上游轮次，例如 `{"req":2,"design":1}` |

端口数据库迁移沿用现有 additive migration 方式：
在 [migrations.py](/Users/xzr/Desktop/workstep/apps/daemon/models/migrations.py:49)
的 `_ADDITIVE_COLUMNS["step_runs"]` 增加列，并补必要索引。

建议增加非唯一索引：

```sql
CREATE INDEX IF NOT EXISTS step_runs_task_step_round
ON step_runs(step_key, artifact_round);
```

如果现有表名确认是 `step_runs`，直接使用；若模型实际表名不同，以 `StepRun.Meta.table_name`
为准。

### 6.2 分配轮次

在 `TaskRunner` 准备阶段状态时，与当前创建 `StepRun` 的逻辑放在同一个 DB 工作单元内：

1. 查询该任务 + 阶段已出现的最大 `artifact_round`；
2. 兼容扫描 legacy 阶段根目录和已有数字轮目录，取最大值；
3. `next_round = max_existing + 1`；
4. 写入新的 `StepRun.artifact_round`；
5. 返回值把 `artifact_round` 一并传给 Prompt、审核、产物扫描。

必须遵守项目 Peewee 异步隔离约束：查询、最大值计算、`StepRun.create()` 都在
`TaskRunner._run_db(...)` 工作单元内完成；异步事件循环上只使用返回的纯数据。

### 6.3 复用轮次

`reused` 类型的 `StepRun` 不产生新轮，复制来源 `StepRun.artifact_round` 到
`artifact_round`，并记录 `source_step_run_id`。

## 7. Manifest

每个轮次目录下由 Daemon 生成 `manifest.json`，不要让 LLM 自己生成。

示例：

```json
{
  "version": 1,
  "workflow": "development",
  "task_id": "task-123",
  "step_key": "req",
  "round": 2,
  "previous_round": 1,
  "workflow_run_id": "run-uuid",
  "step_run_id": "step-run-uuid",
  "input_rounds": {
    "design": 3
  },
  "status": "succeeded",
  "eligible_for_downstream": true,
  "generated_at": "2026-09-17T10:00:00+08:00",
  "artifacts": [
    {
      "name": "PRD 文档",
      "type": "Markdown",
      "path": "prd.md",
      "size": 1234,
      "sha256": "..."
    }
  ]
}
```

生成时机：

- 阶段执行结束后扫描当前轮目录；
- 失败或取消也生成 manifest，但 `eligible_for_downstream` 为 `false`；
- 审核通过后更新 `eligible_for_downstream` 和最终状态；
- `manifest.json` 自身不列入 `artifacts`。

`artifacts[].path` 必须相对当前轮目录；读取时校验解析后的路径仍在当前轮目录内。

## 8. Prompt 改动

### 8.1 输出目录

`assemble_prompt` 和 `assemble_followup_prompt` 都要接受当前 `artifact_round`：

```text
.workstep/artifacts/<工作流>/<任务>/<阶段>/<轮数>/
```

Prompt 必须明确：

- 本轮只写入当前轮目录；
- 不要修改历史轮目录；
- 文件型产物直接写 `<产物名>.<扩展名>`；
- 目录型产物创建 `<产物名>/`；
- `manifest.json` 由系统生成，不需要模型写入。

### 8.2 上游产物

下游 Prompt 只注入被选中的上游轮次。

默认：

```text
req: 最新可继承轮
design: 最新可继承轮
```

显式：

```text
req: 第 2 轮（用户指定）
design: 第 1 轮（最新可继承轮）
```

上游引用格式建议：

```markdown
## 上游产物（已选中轮次）

### 阶段: req
- 轮次: 2
- manifest: .workstep/artifacts/development/task-123/req/2/manifest.json
- prd.md: .workstep/artifacts/development/task-123/req/2/prd.md
```

同时可以列出可替换的历史轮摘要，便于协调 Agent 或用户判断：

```markdown
### 可沿用轮次
- req 第 1 轮：已通过，2 个产物
- req 第 2 轮：已通过，3 个产物（当前默认）
```

历史轮摘要应受条数限制，避免 Prompt 过长。

## 9. 审核改动

`ReviewGate` 只审核当前 `StepRun` 对应的当前轮目录：

```text
.workstep/artifacts/<工作流>/<任务>/<阶段>/<artifact_round>/
```

审核 Prompt 中的“产物文件”必须来自当前轮，不允许混入历史轮或旧阶段根目录。

自动审核反馈仍然注入下一轮执行 Prompt。下一轮写入新的轮目录，并默认继承同一组
已选中的上游轮次。

## 10. 重跑与恢复

### 10.1 从阶段重跑

`restart_from_stage` 调整为：

- 不再调用 `_archive_stage_artifacts` 移动旧产物；
- 保留旧轮目录；
- 重置受影响阶段状态；
- 新 `WorkflowRun` 中子阶段执行时分配新的 `artifact_round`；
- 可复用阶段复制来源轮次，不写新产物。

`_archive_stage_artifacts` / `_restore_archived_artifacts` 第二版可以删除或仅保留给
不再使用的 legacy 路径兼容；正常重跑路径不得再依赖它们。

### 10.2 自动审核重跑

自动重跑不创建新的 `WorkflowRun`，但创建新的 `StepRun`，因此获得新的
`artifact_round`。审核反馈进入新 Prompt，新产物写新轮目录。

### 10.3 daemon 恢复

daemon 重启后中断的 `StepRun` 标记失败；重新调度时创建新的 `StepRun` 和新轮次。
已经部分写出的中断轮目录保留，manifest 标为 `failed` 或 `interrupted`，不得覆盖。

## 11. API 与前端

### 11.1 `TaskArtifact`

后端产物列表给每条记录增加轮次维度：

```ts
round: number
is_latest: boolean
is_selected: boolean
```

`relative_path` 仍相对当前轮目录，避免前端把 `<轮数>/` 拼进文件名。

建议同时返回：

```ts
manifest_status: string | null
eligible_for_downstream: boolean
```

### 11.2 展示

任务详情产物区按阶段 -> 轮次分组：

- 默认展开当前阶段当前轮或最新轮；
- 历史轮可切换查看；
- 明确标识“最新可继承轮”和“本次沿用轮”；
- 失败/驳回轮也可见，但不可作为下游默认输入；
- 分享页复用同一数据结构和展示组件。

### 11.3 API 契约测试

更新 [test_api_contracts.py](/Users/xzr/Desktop/workstep/apps/daemon/tests/test_api_contracts.py:2072)：

- 新轮目录被正确识别；
- legacy 阶段根目录仍被识别为第 1 轮兼容数据；
- 数字轮目录不被当作文件型产物；
- `round`、`is_latest`、`is_selected` 字段正确；
- 目录型产物仍只展示 manifest 声明的目录，不展示嵌套目录噪声。

## 12. 协调 Agent

`artifact_index` 改为覆盖轮次维度，artifact ID 必须包含：

```text
workflow / task / step / round / relative_path
```

每条 artifact metadata 增加：

```json
{
  "round": 2,
  "is_latest_success": true,
  "is_selected": true,
  "eligible_for_downstream": true
}
```

协调 Agent 的指令更新：

- 用户说“沿用 req 第 2 轮”时，在 `rerun_from_stage` proposal payload 中带
  `input_rounds: {"req": 2}`；
- 如果需要检查某轮内容，通过 `artifact_requests` 请求对应的 artifact ID；
- 不要求协调 Agent 自己拼接文件路径；
- 不要求协调 Agent 理解 Git。

`input_rounds` 解析和校验由后端完成：

- 轮次必须存在；
- 轮次必须属于目标阶段的依赖；
- 轮次必须是可继承轮；
- 否则返回明确错误，要求用户选择有效轮次。

## 13. 流程阶段派发

本地派发和远程派发都复制“选中的上游轮”，不是整个阶段目录。

派发 manifest 至少包含：

```json
{
  "source_step_key": "req",
  "source_round": 2,
  "name": "PRD 文档",
  "path": "..."
}
```

远程 `DispatchFile` 增加 `source_round`，接收端保存到任务输入目录时保持该元数据，
下游 Prompt 的外部输入引用中可以展示来源轮次。

## 14. Legacy 兼容

兼容策略：

- 旧的 `<工作流>/<任务>/<阶段>/` 根目录按第 1 轮兼容读取；
- 如果根目录已被当作 legacy 第 1 轮，后续新执行从第 2 轮开始；
- 不做自动搬迁，避免重跑时移动用户文件和破坏历史；
- 旧 `<阶段>/<任务>/` 归档路径只作为历史遗留识别，不作为新写入路径；
- 旧消息、旧审核记录、旧分享数据不需要回填轮次，读取时使用 `round = 1` 或 `null`
  的兼容投影。

新轮目录命名使用纯数字 `1/`、`2/`，不用 `round-1/` 或时间戳。时间戳无法直接回答
“第几轮”，也不利于用户和 LLM 口述定位。

## 15. 测试计划

先写测试，再改实现。

### 15.1 后端

新增或更新：

- `test_pipeline.py`
  - 首次执行 Prompt 指向 `req/1/`；
  - 自动重跑 Prompt 指向 `req/2/`；
  - 下游默认注入 `req/2/`；
  - 显式 `input_rounds={"req":1}` 时注入 `req/1/`；
  - 旧 `req/` 根目录按第 1 轮兼容读取。
- `test_workflow_runtime.py`
  - `restart_from_stage` 不移动旧轮；
  - 重启后新执行分配新 `artifact_round`；
  - reusable 阶段复制来源轮次。
- `test_review_gate.py`
  - 审核只检查当前轮目录；
  - 审核通过后当前轮 manifest 标记为可继承。
- `test_api_contracts.py`
  - `/api/task/{task_id}/artifacts` 返回 `round` 等字段；
  - 分享接口返回同样字段。
- `test_coordinator.py`
  - artifact index 包含轮次；
  - “沿用 req 第 2 轮”可以转成 `rerun_from_stage.payload.input_rounds`；
  - artifact request 能读取指定轮次内容。
- task dispatch 测试
  - 本地和远程派发都带 `source_round`。

运行：

```bash
rtk uv run pytest apps/daemon/tests/test_pipeline.py \
  apps/daemon/tests/test_review_gate.py \
  apps/daemon/tests/test_workflow_runtime.py \
  apps/daemon/tests/test_coordinator.py \
  apps/daemon/tests/test_api_contracts.py -v
```

### 15.2 前端

更新产物列表和分享页测试：

- 按轮次分组；
- 默认展示最新轮；
- 可切换历史轮；
- 显示“本次沿用轮”；
- `round` 字段缺失时兼容旧接口。

运行：

```bash
rtk yarn test
rtk yarn build
```

## 16. 实施顺序

1. 新增 `artifact_rounds.py` 和单元测试，锁定目录、legacy、轮次解析契约。
2. 增加 `StepRun.artifact_round` / `input_rounds_json` 迁移和模型字段。
3. 改 `TaskRunner`：分配轮次，写新轮目录，生成 manifest。
4. 改 Prompt：输出目录和上游轮次选择。
5. 改 `ReviewGate`：只读当前轮，并更新 manifest 可继承状态。
6. 改 `restart_from_stage`：停止归档移动，新执行写新轮。
7. 改 artifacts API、协调 Agent、分享 API。
8. 改 task dispatch 本地与远程 manifest。
9. 改前端产物区与分享页展示。
10. 跑后端和前端回归，修正兼容问题。

## 17. 默认决策

实施时默认采用：

- 每阶段每次真实执行占一轮；
- 下游默认使用最新可继承轮；
- 用户显式指定时使用 `input_rounds`；
- Git 不进入第一版主链路；
- legacy 阶段根目录按第 1 轮兼容，不自动搬迁；
- manifest 由 Daemon 生成，不让 LLM 写。
