# 定时任务助手：任务创建 Agent 的定时调用

> 状态：已实现。本文为设计与实施记录，当前行为由 `services/schedule.py`、`agent_assistants/task_draft.py`、CLI、前端计划页及测试守护。

## 1. 结论

定时任务的「AI 生成」执行模式不是新助手，而是**任务创建助手（`agent_assistants/task_draft.py`，channel `task_create`）的定时（headless）调用**。到点时由 `services/schedule.py` 以任务配置为上下文运行一次任务助手回合，助手产出最终任务标题、Markdown 任务内容与目标流程/阶段，`schedule.py` 再经 `create_project_task` 建任务并派发。静态模式（现有直接建任务）保留，两种模式并存且向后兼容。

## 2. 数据形状（`task_template_json`）

- 静态模式（`mode` 缺省即 static，旧数据无需迁移）：
  `{"title", "description?", "start_step_key?", "review_overrides?"}`
- Agent 模式：
  `{"mode":"agent", "instruction"(必填), "title"?, "description"?, "candidate_workflow_ids": [], "retry_count"(默认2)}`
  - 候选为空 = 项目全部未删除流程；`Schedule.workflow_id` 在 Agent 模式存 `""`（列保持非空，无迁移）。

## 3. 执行流程

1. `ScheduleModule._execute_run` 按 `mode` 分支：静态走原 `create_project_task` 路径；Agent 模式走 `_run_agent_attempts`。
2. `_run_agent_attempts` 循环 `1 + retry_count` 次调用 `task_draft_module.run_schedule(...)`：
   - 每次是新会话（内存态），`retry_feedback` 注入 prompt，超时默认 10 分钟（`SCHEDULE_AGENT_TIMEOUT_SECONDS`）。
   - 成功拿到 `{title, description, workflow_id, start_step_key?}` 后按结果调 `create_project_task`（Agent 模式不使用 review_overrides）。
3. 重试耗尽 → run 标记 `failed` 并写入 `reason`，定时任务本身保持有效（下次照常触发）。
4. `project.py` 删除流程时同步剔除 Agent 模式候选；显式候选被删空 → 定时任务置 `invalid`（原因“候选流程已删除”）。

## 4. 助手侧行为（`agent_assistants/task_draft.py`）

- `submit_message` 新增可选参数：`instruction`、`candidate_workflow_ids`、`allow_generate_title`、`retry_feedback`；`allow_generate_title=True` 即定时模式（标题可生成）。
- 新增 `async run_schedule(...)`：headless 入口，通过 `AssistantRuntime.await_turn`（`base.py` 新增，等待回合完成并抛回合错误/超时）取回结构化结果，不创建任务。
- 定时模式 system prompt 禁止 `ask_user` 与 `workstep_create_task` 等交互/副作用工具；可调用只读 Skill / `workstep_*` 工具；结果 JSON：
  `{"reply": "...", "task_draft": {"title", "description", "workflow_id", "start_step_key?"}}`
- 校验：标题与内容非空；`workflow_id` 必须在候选内（空=全部）；`start_step_key`（可选）必须是该流程编译步骤 key（缺省=第一阶段）；校验失败走修复式再调用。

## 5. 对外接口

- 复用 `/api/task-draft/chat|stop`，扩展参数 `instruction/candidate_workflow_ids/allow_generate_title`（交互模式缺省行为不变）。
- 前端复用 `taskDraftStore`（`workstep.task_draft` 载荷扩展 title/workflow_id）与 `AiTaskCreateChat`（新增 `allowGenerateTitle`/`candidateWorkflowIds` props）；`SchedulePage` 增加「生成方式」切换、生成指令、候选流程多选、重试次数与「测试生成」预览弹框。
- CLI：`workstep schedule create|update --mode agent --instruction ... --candidates w1,w2 --retry-count 2`（`--workflow` 在 Agent 模式可选）。

## 6. 已知边界（v1）

- Agent 模式不使用审核覆盖（`review_overrides` 仅静态模式生效）。
- headless 全自动、无人工确认；单次尝试超时默认 10 分钟，立即重试（次数可配置）。
- 会话仅内存，不跨重启恢复。
