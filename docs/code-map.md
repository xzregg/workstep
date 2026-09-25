# 按功能查找代码

修改功能时先找所属模块，再沿前端页面或组件 → API → 服务 → 数据模型追踪。行为测试放在实际拥有该行为的模块附近；不要把页面、`src/api/client.ts` 或通用服务文件作为新功能的默认落点。

| 功能 | Web 入口 | Daemon 入口 | 深入阅读 |
|---|---|---|---|
| 任务列表、详情、执行 | `src/pages/TaskList.tsx`、`TaskDetail.tsx`，`src/components/TaskDetailView.tsx`；详情内部见下表，API 在 `src/api/task.ts` | `api/task.py`、`services/task.py`、`task_creation.py`、`task_runner.py` | `docs/workflow-engine-execution.md` |
| 流程定义与画布 | `src/components/FlowCanvas.tsx`、`flowCanvasData.ts`、`NodeConfigPanel.tsx` | `api/workflow.py`、`services/workflow_definition.py`、`workflow_runtime.py`；恢复决策在 `workflow_recovery.py` | `docs/workflow-engine-execution.md` |
| 助手与聊天 | `src/components/AssistantChatPanel.tsx`、`ChatInput.tsx`、`src/api/conversations.ts` | `agent_assistants/base.py`、`session_state.py`、`persistence.py`、`history.py` | `AGENTS.md` 助手架构与事件边界 |
| 引擎与安装 | `src/api/engine.ts`、`src/pages/SettingsPage.tsx` | `api/engine.py`、`engines/core/`、`services/engine_runtime.py` | `docs/multi-engine-architecture.md`、`docs/engine-runtime-management.md` |
| 项目与远程项目 | `src/api/project.ts`、`src/pages/SettingsPage.tsx` | `api/project.py`、`remote_project.py`、`services/project.py`、`remote_project.py` | `docs/architecture.md` |
| Git 与任务工作区 | `src/components/git/`、`src/api/git.ts` | `api/git.py`、`services/git/` | `services/git/task_workspace.py` 负责任务工作区 |
| 分享、定时、统计 | `src/api/share.ts`、`schedule.ts`、`statistics.ts` | `api/share.py`、`schedule.py`、`statistics.py`；对应 `services/` | 各模块测试 |
| 用量与费用计算 | `src/api/statistics.ts` | `services/usage_accounting.py`，由 `statistics.py` 与 `task_execution_report.py` 共用 | `tests/test_usage_accounting.py` |
| 通用控件与移动样式 | `src/components/Button.tsx`、`Input.tsx`、`Select.tsx`、`Textarea.tsx`、`src/index.css`、`src/mobile.css` | — | `docs/frontend-design.md`、`tests/mobileButtonSizing.test.mjs` |

表中的前端路径均相对于 `apps/web/`，后端路径均相对于 `apps/daemon/`。后端请求模型在 `schemas/`，持久化模型在 `models/`；服务里的同步数据库工作单元通过 `services/project_database.py` 的项目执行器运行。实时事件从 `engines/core/events.py` 经 `engines/core/agui.py` 到前端 `src/utils/agui.ts`。

## 任务详情内部定位

以下组件位于 `apps/web/src/components/`，测试位于 `apps/web/tests/`。`TaskDetailView.tsx` 负责组装和跨区域协调；新增行为应放到实际拥有它的组件，并同步更新此表。

| 功能 | 代码入口 | 行为测试 |
|---|---|---|
| 页头、创建者、关闭操作 | `TaskDetailHeader.tsx` | `actorVisibility.test.mjs`、`taskDetailPageReuse.test.mjs` |
| 描述展示与编辑 | `TaskDetailDescription.tsx` | `taskDetailProgressLayout.test.mjs` |
| 桌面、移动及产物轮次页签 | `TaskDetailTabs.tsx` | `taskDetailTabs.test.tsx` |
| 步骤进度图 | `TaskStepProgressGraph.tsx` | `taskDetailProgressLayout.test.mjs` |
| 步骤输入、输出、产物轮次及重新执行 | `TaskStepIoPanel.tsx` | `taskStepIoPanel.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 审核结果与决策 | `TaskReviewResult.tsx` | `taskReviewResult.test.tsx`、`reviewTerminateAction.test.mjs` |
| 审核设置 | `TaskReviewConfigPanel.tsx` | `taskReviewConfigPanel.test.tsx` |
| 消息时间线与滚动 | `taskConversationFeed.ts`、`src/hooks/useTaskConversationScroll.ts` | 对应 conversation 测试 |

## 修改路径

1. 用上表找到职责所有者，搜索其调用者和对应测试；跨层改动同时核对 API、schema、状态和界面。
2. 行为变更先写能复现问题的测试；移动样式核对 `mobile.css` 的共享尺寸变量和移动端检查；异步 I/O 用慢 I/O 加健康检查或轻量协程验证事件循环响应。
3. 只在职责独立、调用边界清楚时拆模块。行数与状态数量是发现问题的信号，不是拆文件目标；避免透传整组状态或让维护入口散落。
4. 更新本表和相应专题文档，运行相关测试、完整测试及构建。具体命令见 [开发指南](development.md)。
