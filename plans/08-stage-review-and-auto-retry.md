# 阶段审核与自动重跑方案

## 1. 目标

每个工作流阶段执行完成后必须经过审核关卡，只有审核通过才能释放下游阶段。

- 阶段可配置是否启用自动审核。
- 自动审核由独立审核 Agent 检查阶段结果和产物。
- 自动审核不通过时，可根据阶段配置自动重跑。
- 自动审核关闭时，阶段等待用户人工审核和确认。
- 自动重跑次数耗尽后暂停任务，等待用户处理。
- 审核和重跑过程完整留痕，不覆盖历史执行结果。

## 2. 阶段配置

在工作流的每个阶段增加 `review` 配置：

```json
{
  "key": "frontend",
  "label": "前端开发",
  "engine": "codex",
  "model": "",
  "prompt": "根据设计稿完成前端开发。",
  "review": {
    "auto": true,
    "maxRetries": 2,
    "engine": "codex",
    "model": "",
    "prompt": "检查产物完整性、格式和需求覆盖情况。"
  }
}
```

字段语义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `review.auto` | boolean | 是否在阶段执行完成后启动审核 Agent |
| `review.maxRetries` | integer | 审核不通过时允许的额外自动重跑次数 |
| `review.engine` | string | 审核 Agent 使用的引擎；为空时继承阶段引擎 |
| `review.model` | string | 审核 Agent 使用的模型；为空时继承阶段模型 |
| `review.prompt` | string | 阶段专属审核要求和检查清单 |

`maxRetries` 表示首次执行之外的额外重跑次数：

- `0`：首次自动审核不通过后直接暂停。
- `1`：最多执行两次。
- `2`：最多执行三次。

新建阶段会明确写入以下默认配置：

```json
{
  "auto": false,
  "maxRetries": 1,
  "engine": "",
  "model": "",
  "prompt": ""
}
```

对于升级前已经存在、完全缺少 `review` 字段的旧工作流，继续采用原有
“执行成功即通过”行为，避免升级后正在使用的流程突然在每个阶段暂停。
用户在阶段编辑器保存该阶段后会写入明确配置，此后严格经过自动或人工审核。

## 3. 审核关卡

在阶段执行成功与 `passed` 之间增加统一的 `ReviewGate` 模块：

```text
阶段执行成功
  ├─ 自动审核关闭
  │    └─ awaiting_review
  │         ├─ 用户通过 → passed → 释放下游
  │         └─ 用户驳回 → rejected → paused
  │
  └─ 自动审核开启
       └─ reviewing
            ├─ 审核通过 → passed → 释放下游
            └─ 审核不通过
                 ├─ 未达到 maxRetries
                 │    └─ 注入审核意见 → 新建 attempt → 自动重跑
                 └─ 次数耗尽
                      └─ rejected → paused
```

`TaskRunner` 不再因为执行引擎正常退出而直接将阶段标记为 `passed`。执行完成后必须调用 `ReviewGate`，由审核关卡决定：

- 启动自动审核；
- 等待人工审核；
- 根据审核意见自动重跑；
- 标记阶段通过；
- 暂停任务并等待用户处理。

`ReviewGate` 是审核功能的主要 seam，对执行器提供小型 interface，并在内部隐藏审核引擎调用、报告解析、状态变更、重跑判断和事件发布。

## 4. 自动审核 Agent

### 4.1 审核输入

系统为审核 Agent 组装独立 Prompt，至少包含：

1. 当前阶段名称、key 和阶段目标；
2. 当前阶段原始 Prompt；
3. 阶段声明的 inputs 和 outputs；
4. 上游产物路径；
5. 本阶段生成或修改的产物路径；
6. 本次执行 Agent 的最终输出；
7. 阶段专属 `review.prompt`；
8. 结构化返回格式要求。

审核 Agent 只负责检查和报告，不直接修改产物。

### 4.2 审核输出

审核 Agent 必须返回：

```json
{
  "passed": false,
  "score": 72,
  "summary": "主要功能已完成，但缺少单元测试。",
  "issues": [
    {
      "severity": "error",
      "category": "missing_artifact",
      "description": "没有发现要求的 Vitest 测试文件。",
      "suggestion": "为主要页面和状态管理补充单元测试。"
    }
  ]
}
```

字段约束：

- `passed`：是否允许进入下一阶段；
- `score`：`0-100`；
- `summary`：审核结论摘要；
- `issues[].severity`：`error | warning`；
- `issues[].category`：问题分类；
- `issues[].description`：具体问题；
- `issues[].suggestion`：修复建议。

审核进程报错、超时或返回无法解析的 JSON 时，按审核不通过处理，并生成系统问题记录。

## 5. 自动重跑

自动审核不通过且仍有重跑额度时：

1. 保存本次 `StepRun` 和 `ReviewRun`；
2. 汇总审核报告中的 `summary` 和 `issues`；
3. 将审核意见作为“上一轮审核反馈”加入阶段 Prompt；
4. 创建新的 `StepRun` attempt；
5. 使用原阶段执行引擎重新执行；
6. 执行完成后创建新的审核记录并再次审核。

重跑 Prompt 结构：

```markdown
[系统指令]

[上游产物引用]

[阶段原始 Prompt]

## 上一轮审核反馈

审核结论：...

需要修复：
- ...
- ...

请在保留已有正确结果的基础上修复以上问题。

[用户补充说明]
```

每次重跑：

- 创建独立 `StepRun`；
- 创建独立 `Message`；
- 创建独立 `ReviewRun`；
- 产物按现有版本机制生成新版本；
- 不覆盖旧 attempt 的消息、审核报告和错误信息。

审核异常同样占用一次自动重跑机会，避免审核 Agent 异常导致无限循环。

## 6. 状态模型

### 6.1 阶段状态

`task_steps.status` 扩展为：

| 状态 | 含义 |
|---|---|
| `pending` | 尚未执行 |
| `running` | 阶段 Agent 正在执行 |
| `reviewing` | 自动审核 Agent 正在运行 |
| `awaiting_review` | 等待用户人工审核 |
| `retrying` | 审核不通过，正在自动重跑 |
| `passed` | 审核通过，可满足下游依赖 |
| `rejected` | 审核未通过且未继续 |
| `failed` | 阶段执行本身失败 |
| `skipped` | 阶段被跳过 |

只有 `passed` 和 `skipped` 可以满足 DAG 依赖。

### 6.2 任务状态

- 自动审核和自动重跑期间，`tasks.status` 保持 `running`。
- 等待人工审核时，任务状态为 `paused`。
- 自动重跑次数耗尽时，任务状态为 `paused`。
- 人工驳回时，任务状态为 `paused`。
- 所有最终阶段审核通过后，工作流才标记为 `succeeded`。

并行分支分别执行和审核。一个分支等待人工审核时，其他已就绪且不依赖该分支的阶段仍可继续；汇合节点必须等待所有依赖阶段变为 `passed`。

## 7. 数据模型

新增 `review_runs` 表：

```sql
CREATE TABLE review_runs (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL,
    step_run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    mode TEXT NOT NULL,                  -- auto / manual
    status TEXT NOT NULL,                -- pending / running / passed / rejected / failed
    engine TEXT,
    model TEXT,
    prompt_json TEXT,
    response_text TEXT,
    report_json TEXT,
    decision TEXT,                       -- approve / reject / force_approve
    decision_comment TEXT,
    decided_at INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    error TEXT,
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
    FOREIGN KEY (step_run_id) REFERENCES step_runs(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_review_runs_task_step
ON review_runs(task_id, step_key);

CREATE UNIQUE INDEX idx_review_runs_step_attempt
ON review_runs(step_run_id, attempt);
```

审核记录必须关联具体 `StepRun`，避免旧 attempt 的审核决定错误放行新 attempt。

## 8. 后端接口

新增接口：

```text
GET  /api/task/{taskId}/reviews
POST /api/task/{taskId}/steps/{stepKey}/review/approve
POST /api/task/{taskId}/steps/{stepKey}/review/reject
POST /api/task/{taskId}/steps/{stepKey}/review/force-approve
POST /api/task/{taskId}/steps/{stepKey}/retry
```

审核决定请求包含：

```json
{
  "step_run_id": "...",
  "review_run_id": "...",
  "comment": "确认通过"
}
```

接口要求：

- 审批操作幂等；
- 只允许操作当前活动 attempt；
- 拒绝已被新 attempt 替代的审核记录；
- `approve` 用于正常人工审核通过；
- `reject` 保存用户意见并暂停；
- `force-approve` 用于忽略自动审核问题并强制放行；
- `retry` 创建新的阶段 attempt，并可注入用户补充说明。

## 9. 实时事件

WebSocket/SSE 增加：

| 事件 | 用途 |
|---|---|
| `review_status` | 审核状态变化 |
| `review_event` | 审核 Agent 的流式输出和工具事件 |
| `review_result` | 最终结构化审核报告 |
| `step_retrying` | 阶段即将按审核意见重跑 |

所有事件包含：

```json
{
  "task_id": "...",
  "step_key": "frontend",
  "workflow_run_id": "...",
  "step_run_id": "...",
  "review_run_id": "...",
  "status": "reviewing"
}
```

审核 Agent 的消息必须与阶段执行 Agent 的消息分组展示，不能混合为同一段对话。

## 10. 前端设计

### 10.1 阶段编辑器

阶段编辑面板增加：

- “自动审核”开关；
- 审核不通过自动重跑次数；
- 审核引擎；
- 审核模型；
- 审核要求/检查清单。

自动审核关闭时，禁用或隐藏审核引擎、审核模型、审核 Prompt 和重跑次数。

重跑次数使用非负整数输入，默认 `1`，并明确提示：

> 指首次执行之外允许的额外重跑次数。

### 10.2 任务详情

阶段时间线增加以下状态：

- 自动审核中；
- 等待人工审核；
- 审核未通过；
- 修复重跑中；
- 审核通过。

详情页展示：

- 当前执行 attempt，例如“第 2/3 次执行”；
- 审核引擎和模型；
- 审核分数与摘要；
- issues 列表及严重级别；
- 历次执行和审核记录。

人工审核操作：

- `通过并进入下一阶段`；
- `驳回`，并填写意见。

自动审核次数耗尽后的操作：

- `再次重跑当前阶段`；
- `强制通过并进入下一阶段`。

## 11. 实施顺序

1. 扩展工作流 schema、校验和编译逻辑，支持 `review` 配置。
2. 增加数据库 migration、`ReviewRun` 模型和查询能力。
3. 实现 `ReviewGate` 和审核报告解析。
4. 修改 `TaskRunner`，取消“执行成功即 passed”，接入审核与自动重跑。
5. 增加人工审批、强制通过和手动重跑接口。
6. 增加审核相关实时事件。
7. 更新阶段编辑器和任务详情页。
8. 补充文档、默认模板、后端测试和前端交互测试。

## 12. 验收测试

### 自动审核

- 首次审核通过后才启动下一阶段。
- 审核不通过时，审核意见正确注入下一次执行 Prompt。
- `maxRetries=0/1/2` 分别产生最多 `1/2/3` 次阶段执行。
- 重跑后审核通过，工作流正常继续。
- 次数耗尽后任务暂停，下游保持 `pending`。

### 人工审核

- 自动审核关闭时不启动审核 Agent。
- 阶段执行完成后进入 `awaiting_review`。
- 用户通过后释放下游。
- 用户驳回后任务保持暂停并保存意见。

### 异常与一致性

- 审核 Agent 报错、超时和无效 JSON 不会误放行。
- 每次执行和审核拥有独立历史记录。
- 旧审核请求不能批准新的阶段 attempt。
- 重复审批请求不会重复启动下游阶段。
- 页面刷新和 WebSocket 重连后可恢复审核状态、报告和剩余重跑次数。

### DAG

- 并行分支可以独立执行、审核和重跑。
- 汇合节点只在所有依赖阶段审核通过后启动。
- 最后一个阶段审核通过前，工作流不能标记为完成。
