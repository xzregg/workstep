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
| 任务弹窗位置、尺寸、四边四角缩放与键盘移动 | `TaskDetailWindow.tsx`；`TaskDetail.tsx` 只装配内容 | `taskDetailWindow.test.tsx` |
| 任务描述展示、编辑保存及定时启动时间调整 | `TaskDetailDescription.tsx`；任务页启用编辑，分享页只读 | `taskDescriptionEditing.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 步骤提示词快速编辑、保存和错误恢复 | `StepPromptEditor.tsx`；`TaskDetail.tsx` 只选择步骤并在保存后更新项目状态 | `stepPromptEditor.test.tsx` |
| 当前步骤提示词展示与快捷编辑入口 | `TaskStepPrompt.tsx`；任务页可编辑，分享页只读；固定样式在 `src/index.css` 的 `task-step-prompt-*` 类 | `taskStepPrompt.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 桌面、移动及产物轮次页签 | `TaskDetailTabs.tsx` | `taskDetailTabs.test.tsx` |
| 任务详情两栏分割比例、拖动与会话持久化 | `TaskDetailSplitLayout.tsx`；`TaskDetailView.tsx` 只装配步骤、对话和移动端产物内容 | `taskDetailSplitLayout.test.tsx` |
| 任务消息发送目标、步骤可恢复状态提示 | `TaskChatTargetTabs.tsx`；任务详情 View 仅提供目标与步骤状态 | `taskChatTargetTabs.test.tsx`、`mobileTaskTargetTabs.test.mjs` |
| 步骤进度图交互和渲染 | `TaskStepProgressGraph.tsx` | `taskStepProgressGraph.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 步骤进度图的依赖布局、连线几何与轮次 | `taskStepProgressLayout.ts` | `taskStepProgressLayout.test.ts`、`taskStepProgressGraph.test.tsx` |
| 步骤输入、输出、产物轮次及重新执行 | `TaskStepIoPanel.tsx` | `taskStepIoPanel.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 审核结果展示与操作入口 | `TaskReviewResult.tsx` | `taskReviewResult.test.tsx`、`reviewTerminateAction.test.mjs` |
| 审核列表刷新、决策提交、失败执行标记完成与下游调度确认 | `src/hooks/useTaskReviewActions.ts`；`TaskDetail.tsx` 只接入审核面板和确认框 | `useTaskReviewActions.test.tsx` |
| 步骤审核设置的草稿、保存与错误恢复 | `TaskReviewConfigPanel.tsx`；任务页仅开启编辑，分享页不显示设置 | `taskReviewConfigPanel.test.tsx` |
| 消息时间线与滚动 | `taskConversationFeed.ts`；滚动行为由 `src/hooks/useTaskConversationScroll.ts` 管理，任务、助手和过程追踪共用规则在 `src/utils/conversationScroll.ts` | `conversationScroll.test.ts`、`streamingSelection.test.tsx` 及对应 conversation 测试 |
| 单条任务消息的发送者、执行状态、审核操作、产物与元数据 | `TaskConversationMessage.tsx`；`TaskDetailView.tsx` 只选择消息顺序并接入时间线，`TaskMessageArtifacts.tsx` 展示产物入口 | `taskConversationMessage.test.tsx`、`taskConversationRuntime.test.ts`、`taskMessageArtifacts.test.tsx` |
| 任务历史、向上分页与消息事件详情 | `src/hooks/useTaskHistory.ts` | `taskHistory.test.tsx`、`remoteChatSync.test.mjs` |
| 任务协调引擎配置与供应商/模型选择 | `src/hooks/useTaskCoordinatorConfig.ts`；`TaskDetail.tsx` 负责接入任务详情输入区 | `useTaskCoordinatorConfig.test.tsx` |
| 步骤停止、丢失会话重启与失败消息重试 | `src/hooks/useTaskStepControls.ts`；任务详情提供历史刷新和错误展示回调 | `useTaskStepControls.test.tsx` |
| 任务历史刷新合并、事件详情归并与失败重试 | `src/pages/taskHistoryModel.ts`；本地详情、分享页及历史 hook 共用 | `taskDetailChat.test.ts`、`taskHistory.test.tsx` |
| 任务产物选择、轮次、步骤输入输出映射与接口变更判断 | `src/pages/taskArtifactRules.ts`；`TaskStepIoPanel.tsx` 展示结果，本地详情与分享页共用产物查找 | `taskDetailChat.test.ts`、`taskStepIoPanel.test.tsx` |
| 任务产物列表加载、生成后刷新、预览与打开本地目录 | `src/hooks/useTaskArtifacts.ts`；`TaskDetail.tsx` 负责将状态接入详情页，远端项目禁用本地目录操作 | `useTaskArtifacts.test.tsx` |
| 任务归档经验草稿、生成和确认 | `ArchiveExperienceDialog.tsx`；任务列表只负责打开和归档后移除卡片 | `archiveExperienceDialog.test.tsx`、`archiveExperienceControls.test.mjs` |
| 看板任务卡片的状态、时长、定时标签与操作按钮 | `TaskBoardCard.tsx`；`TaskList.tsx` 负责项目筛选、分组、拖放及请求编排；固定卡片和看板样式在 `src/index.css` 的 `task-board-*` 类 | `taskBoardCard.test.tsx`、`taskListCardStepLabel.test.mjs` |
| 分享页实时消息事件合并、状态更新与事件数量上限 | `src/pages/sharedTaskMessages.ts`；`src/hooks/useSharedTaskSession.ts` 将事件写入消息状态 | `sharedTaskMessages.test.ts`、`useSharedTaskSession.test.tsx` |
| 分享链接的密码解锁、会话过期恢复、首屏快照、实时连接及消息事件详情 | `src/hooks/useSharedTaskSession.ts`；`SharedTaskView.tsx` 只装配任务展示和交互，固定样式在 `src/index.css` 的 `shared-task-*` 类 | `useSharedTaskSession.test.tsx`、`interactiveShareComposer.test.tsx` |
| 新建任务、起始步骤与启动方式、审核覆盖、AI 草稿和关闭保护 | `TaskCreatePanel.tsx`；`TaskList.tsx` 只负责入口和当前项目/流程选择；样式在 `src/index.css` 的 `task-create-*` 类 | `taskCreatePanel.test.tsx`、`assistantPanelToggle.test.mjs` |
| 项目记忆 `.workstep/MEMORY.md` 读取、编辑、保存与放弃确认 | `ProjectMemoryPanel.tsx`；任务列表只负责打开入口；样式在 `src/index.css` 的 `project-memory-*` 类 | `projectMemoryPanel.test.tsx` |

## 修改路径

1. 用上表找到职责所有者，搜索其调用者和对应测试；跨层改动同时核对 API、schema、状态和界面。
2. 行为变更先写能复现问题的测试；移动样式核对 `mobile.css` 的共享尺寸变量和移动端检查；异步 I/O 用慢 I/O 加健康检查或轻量协程验证事件循环响应。
3. 只在职责独立、调用边界清楚时拆模块。行数与状态数量是发现问题的信号，不是拆文件目标；避免透传整组状态或让维护入口散落。
4. 更新本表和相应专题文档，运行相关测试、完整测试及构建。具体命令见 [开发指南](development.md)。
