# 会话聊天模式（Codex 式）实施计划

> 状态：已实现（首版 2026-08-12，后续持续演进）。本文档保留首版规划与落地记录；分叉、权限模式、Provider、视觉模型和 JSONL 事件日志等当前能力以代码及 `plans/session-forking.md` 为准。

## 摘要
- 新增"会话聊天"：按 **项目 → 流程 → 会话** 三级展示，每个流程下可建多个会话；通用编码对话，`cwd` 为项目目录，多轮流式、可停止、引擎/模型可切换。
- 会话消息使用**新表**（不写入现有 `messages`/`tasks`），会话可新建、重命名、删除。
- 输入框上方快捷按钮**按项目独立配置**，会话页内可增删改（标签 + 提示词）。
- 中继：**复用现有 Provider**（自定义 `base_url` 接中继 + cc-switch 导入），不新增"中继服务"模块。
- 对话框、消息、输入、状态、确认弹框**全部复用现有组件**，本功能不新增任何聊天 UI 实现。
- 已支持会话分叉：同引擎优先使用真实原生分叉能力；切换引擎时显式选择智能交接、完整记录或不载入。

## 关键改动

### 数据模型（当前 schema bootstrap + additive migration）
- 当前迁移器直接用模型定义收敛新旧数据库，`LATEST_SCHEMA_VERSION = 0` 仅表示当前基线，不再累计历史迁移号。
- `chat_sessions` 除首版字段外，现已包含 Provider、视觉模型、权限模式、父会话、分叉点、交接上下文和分叉状态等字段。
- `chat_messages` 除首版字段外，现已包含作者快照、JSONL 事件日志路径、事件摘要、事件计数和末序号；`events_json` 只用于旧数据兼容。
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

## 首版测试记录
- 后端覆盖迁移、CRUD、独立消息表、跨 runtime 恢复、幂等、channel 隔离、运行中保护、快捷按钮和 HTTP 契约；当前用例数量以测试收集结果为准。
- 前端覆盖 `session_chat` channel、会话列表、快捷按钮和 i18n；分叉与交接另见对应测试。

## 假设与说明
- 会话挂在流程下（项目 → 流程 → 会话）；会话标题默认取首条用户消息的**第一句话**（按句末标点切分，最长 40 字），可重命名（允许空白字符，仅要求非空）。
- 通用对话不绑定画布、不改动工作流定义。
- 中继：复用现有 Provider 自定义 `base_url` / cc-switch 导入。
