# 会话聊天模式（Codex 式）实施计划

> 状态：已实现（2026-08-12）。本文档为功能规划与落地记录。

## 摘要
- 新增"会话聊天"：按 **项目 → 流程 → 会话** 三级展示，每个流程下可建多个会话；通用编码对话，`cwd` 为项目目录，多轮流式、可停止、引擎/模型可切换。
- 会话消息使用**新表**（不写入现有 `messages`/`tasks`），会话可新建、重命名、删除。
- 输入框上方快捷按钮**按项目独立配置**，会话页内可增删改（标签 + 提示词）。
- 中继：**复用现有 Provider**（自定义 `base_url` 接中继 + cc-switch 导入），不新增"中继服务"模块。
- 对话框、消息、输入、状态、确认弹框**全部复用现有组件**，本功能不新增任何聊天 UI 实现。
- 已支持会话分叉：同引擎优先使用真实原生分叉能力；切换引擎时显式选择智能交接、完整记录或不载入。

## 关键改动

### 数据模型（迁移 v33，`LATEST_SCHEMA_VERSION` 30→33）
- 新表 `chat_sessions`：`id`(uuid)、`project_id`、`workflow_id`、`title`、`sort_order`（拖拽排序，v33 新增）、`engine`、`model`、`fast_model`、`engine_session_id`、`engine_state_json`、`created_at`、`updated_at`，索引 `(project_id, workflow_id, updated_at)`。
- 新表 `chat_messages`：`id`、`session`(FK)、`role`、`content`、`status`、`engine`、`model`、`prompt`、`events_json`、`usage_json`、`created_at`、`ended_at`，索引 `(session, created_at)`。
- 新表 `project_settings`：`project_id`、`key`、`value_json`、`updated_at`，唯一 `(project_id, key)`，存项目级快捷按钮配置。
- 新模型注册进 `ALL_MODELS`。

### 后端
- `agent_assistants/chat_session.py`：注册 `AssistantConfig`（`channel="session_chat"`，`scope="chat"`），实现 `ChatRowPersistence`（消息逐行写入 `chat_messages`，会话行写 `chat_sessions`，标题自动取首条用户消息前 20 字），`session_identity = (chat, project_id, session_id)`。
- 模块方法：`list/create/fork/rename/delete/reorder/get_history/submit/stop` 会话 + `get/set_quick_buttons(project_id)`（校验：标签/提示词非空、长度上限、最多 20 个、id 唯一；未配置时返回内置默认按钮）。列表按 `sort_order` 排序，新会话置顶（`min-1`），`reorder` 重排并落库。
- `api/chat_session.py` 已注册到 `main.py`：`GET/POST /api/chat-sessions`、`GET/PATCH/DELETE /api/chat-sessions/{session_id}`、`POST .../{id}/fork`、`POST .../{id}/chat`（`Idempotency-Key` 幂等）、`POST .../{id}/stop`、`POST /api/chat-sessions/reorder`（拖拽排序）、`GET/PUT /api/chat-sessions/quick-buttons`；会话不存在 404、生成中删除/分叉 409、校验失败 400。
- 引擎默认跟随全局配置（复用协调引擎 fallback 链），会话内可切换并持久化到会话行；WebSocket 无需改动（全局总线按 `channel` 分流）。

### 前端（全部复用现有组件）
- `stores/chatSessionStore.ts`：`createAssistantStore({ channel: 'session_chat' })` 复用消息流；`useChatListStore` 管理会话列表 CRUD 与项目级快捷按钮。
- `pages/ChatPage.tsx`（路由 `/chat?project=&workflow=&session=`）：组合 `AssistantChatPanel`（quickPrompts 插槽复用）+ 头部新建/重命名/删除会话 + 快捷按钮管理弹框（`ConfirmDialog` + 表单，增删改校验）。
- `Layout.tsx` 侧边栏：流程下展开"会话"列表（新建/点击进入/右键重命名删除，`ConfirmDialog` 确认）；新增"会话"导航按钮。
- i18n：`zh-CN.ts` 先行（`chatSession.*` 42 键），`en-US` 真实翻译，`zh-TW`/`ja-JP` 中文占位，键集合一致。

## 测试计划（已完成）
- 后端 `tests/test_chat_session.py`（7 项通过）：迁移建表与版本 32；会话 CRUD round-trip；消息仅写入 `chat_messages`（不污染 `tasks`/`messages`）；跨 runtime 恢复；chat 幂等重放；事件 `channel="session_chat"` 隔离；删除运行中会话报错；quick-buttons 默认值与校验；HTTP 全契约（create/list/get/rename/chat/stop/404/400/删除）。
- 前端 `tests/chatSessionStore.test.ts`（4 项通过）：`session_chat` channel 过滤；会话列表按流程增删改；快捷按钮经 API 保存并更新本地；zh-CN 词典键存在。
- 回归：`uv run pytest` 全量 630+ 通过（4 个既有失败与本次无关，见下）；前端既有测试 + `npm run build` 通过。

## 假设与说明
- 会话挂在流程下（项目 → 流程 → 会话）；会话标题默认取首条用户消息的**第一句话**（按句末标点切分，最长 40 字），可重命名（允许空白字符，仅要求非空）。
- 通用对话不绑定画布、不改动工作流定义。
- 中继：复用现有 Provider 自定义 `base_url` / cc-switch 导入。
- 既有失败（与本次改动无关）：`test_models.py::test_init_db_creates_tables`、`test_workflow_definition.py` 两个用例在 HEAD 上即失败；`test_e2e.py::test_e2e_task_run_publishes_events` 为 WIP 中测试桩（`MemoryConfigStore`）未实现新配置 API 导致。
