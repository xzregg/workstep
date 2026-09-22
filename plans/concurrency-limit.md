# 并发限制与统一项目配置计划

> 状态：已实现（2026-09-07）。全局和项目级并发限制、定时任务豁免及统一「项目配置」弹窗均已落地；末尾保留实现与验证记录。

## 目标

- 新增**全局 + 项目级**并发限制：任务、对话两个通道**独立**限流，互不占用、互不排队。
- 定时任务可豁免（不受任务通道限制，直接运行）。
- 收敛项目级设置为统一「项目配置」弹窗（主从导航布局，同 iOS/系统设置风格）；高频操作按钮保留在页面 Title。

## 需求语义

### 并发限制（双通道独立）

| 限制项 | 作用域 | 排队单位 | 释放条件 |
|---|---|---|---|
| 任务并发数 `max_tasks` | 只看任务（手动 / 定时 / 定时启动统一计） | 任务 | 任务完整走完（含审核、返工） |
| 对话并发数 `max_chats` | 只看会话回复 turn | 会话 | 该轮回复结束 |

- 例：`max_tasks=3` + `max_chats=3` → 同时最多 3 个任务 + 3 个对话（最多 6 个引擎实例）；任务排队不占对话槽位，反之亦然。
- 任务通道满时，即使对话通道全空，第 N+1 个任务仍须排队；对话同理。

### 配置模型（三级解析）

| 层级 | 存储 | 内容 |
|---|---|---|
| 全局（默认值） | `~/.workstep/config.json` | 新增 `"concurrency"` 段：`{"max_tasks": 3, "max_chats": 3, "schedule_exempt": false}`；已有 `"projects"` 段存放项目名称映射（路径 → 显示名称） |
| 项目（覆盖） | 项目 DB `project_settings` 表（已有表，新增 key `concurrency`） | `{"max_tasks": null, "max_chats": null, "schedule_exempt": null}`，`null` = 跟随全局 |
| 兜底 | — | 未配置 = 不限制 |

解析规则：**项目显式值 > 全局值 > 不限制**。`max_tasks` / `max_chats` / `schedule_exempt` 三项各自独立解析。

### 定时任务豁免

`schedule_exempt = true` 时，定时任务（`services/schedule.py` 发起）跳过任务并发闸门直接运行，不占槽位、不排队；`false` / 跟随全局时与手动任务共用任务槽位池，超限同样排队。

### 统一项目配置入口

- 入口：任务看板、聊天页 Title 工具栏**末尾**新增 `⚙ 配置` 按钮（图标 + 文字，与「新建」「分享」等按钮同款式）。
- 高频操作按钮**保留**在 Title：新建任务、视图切换、**分享**、**定时**、**记忆**、归档、目录（任务看板）；引擎选择、新建会话（聊天页）。
- 聊天页的「系统提示词」「快捷按钮」管理入口**迁入**弹窗「对话助手」页签，顶部不再放置。
- 弹窗布局：主从导航——左侧索引栏点击切换，右侧「头部标题联动 + 内容可纵向滚动」。

### 弹窗设置项（4 页签 · 13 项）

| 页签 | 设置项 | 性质 | 存储 |
|---|---|---|---|
| 常规 | 项目名称 | 迁移（左侧项目列表改名入口） | 全局 config `projects` 段 |
| | 项目路径 | 迁移（只读展示） | 项目注册信息 |
| | 新建任务默认引擎 | 新增（跟随全局） | 全局 config |
| 对话助手 | 全局提示词 | 迁移（聊天页弹框） | 项目 DB `project_settings`（key `chat_system_prompt`） |
| | 快捷按钮 | 迁移（聊天页弹框） | 项目 DB `project_settings`（key `chat_quick_buttons`） |
| 并发限制 | 任务并发数 | 新增（核心） | 项目 DB `project_settings`（key `concurrency`） |
| | 对话并发数 | 新增（核心） | 同上 |
| | 定时任务不受限制 | 新增（核心） | 同上 |
| 分享 | 访问类型 | 迁移（分享弹框内容） | 全局 config `remote_access`（按项目关联） |
| | 访问有效期 | 迁移 | 同上 |
| | 生成分享链接 | 迁移 | 同上 |
| | 已授权设备列表 | 迁移 | 同上 |

不归入弹窗：定时任务管理页、工作流/流程画布、模板（全局）、远程访问地址（全局）、审核覆盖（任务/流程级）、项目记忆 `MEMORY.md`（内容编辑，保留看板「记忆」按钮）。

## 实施前基线（2026-09-07 历史代码探查）

- 任务启动唯一入口 `services/workflow_runtime.py::start()`（手动运行 / 定时调度 / 定时启动共用），内部 `TaskRunner` 直接开跑，无任何并发闸门。
- `models/task.py::Task.status` 取值 `ready / running / paused / stopped`；`TaskStep.status` 含 `pending / running / passed / failed / cancelled / retrying / rework_waiting / rework / awaiting_review / reviewing / rejected`。
- 任务看板 `apps/web/src/pages/TaskList.tsx` 用 `STATUS_LABEL_KEYS / STATUS_COLORS` 映射状态泳道，`deriveTaskLane` 按步骤状态推算所在泳道。
- 对话入口 `agent_assistants/base.py::AssistantRuntime.submit_message()` 创建 turn（`_turn_states[turn_id]["status"] = "queued"`），随后 `start_queued_turn()` 立即 `create_task` 启动，queued 只是瞬时状态；`chat_session.py` 是 per-project 多会话聊天助手（channel `session_chat`）。
- 项目级设置现存放：项目 DB `project_settings` 表（`chat_system_prompt`、`chat_quick_buttons` 两个 key）；全局 `~/.workstep/config.json` 单例 `config_store`（含 `projects` 项目名称映射、`remote_access` 分享邀请/授权设备、`prompt_enhance` 等）。
- 全局助手设置 API：`GET/PUT /api/assistant/enhance-config`（`config_store.get/set_prompt_enhance_config`）。
- 项目 DB 读写必须经 `project_manager.run_db`（Peewee 异步隔离规范，见 `AGENTS.md`）。

## 后端设计

### 1. 全局配置读写（`services/config.py`）

- `get_concurrency_config()`：读取 `config.json` 的 `concurrency` 段，`{"max_tasks": int|0, "max_chats": int|0, "schedule_exempt": bool}`；`0`/缺失 = 不限制。
- `set_concurrency_config(max_tasks, max_chats, schedule_exempt)`：写回并 `invalidate()`。
- 合法性：`max_tasks / max_chats >= 0` 整数；`schedule_exempt` 布尔。

### 2. 项目级配置读写（新增 `services/project_settings.py`）

- `get_project_concurrency(project_id) -> dict`：读 `project_settings` 表 key `concurrency`，返回 `{"max_tasks": int|null, "max_chats": int|null, "schedule_exempt": bool|null}`；无记录返回全 `null`。
- `set_project_concurrency(project_id, max_tasks, max_chats, schedule_exempt)`：`null` 表示删除该字段回退全局；全 `null` 删除整行。
- 所有读写经 `project_manager.run_db(project_id, operation)`，遵守 Peewee 异步隔离规范。
- 配置变更后通知 `ConcurrencyGate` 刷新缓存。

### 3. 并发闸门（新增 `services/concurrency.py`）

全局单例 `ConcurrencyGate`：

- 两个独立 `asyncio.Semaphore`：任务通道、对话通道，天然 FIFO 公平。
- 有效配置解析：`get_effective_concurrency(project_id)` → 项目显式值 > 全局值 > 不限制；结果缓存于内存，配置变更时 `invalidate` 刷新，热路径不直连 DB。
- 维护 waiting 队列（任务/会话分别记录排队顺序），提供 `queue_position` 查询供看板/会话列表展示排队位置 `#n`。
- `acquire_task_slot(project_id, source)`：`source == "schedule"` 且 `schedule_exempt` 生效时直接放行（不占槽、不进队列）；否则若任务槽已满则等待，等待期间任务状态为 `queued`。
- `acquire_chat_slot(project_id)`：按会话维度排队——同一会话同时只允许 1 个排队 turn，排队中再发消息追加进该排队项。
- 释放即唤醒：任务在 `TaskRunner` 完成（`task.status` 落定为 `ready / paused / stopped`）后释放；对话在 `_run_turn` 结束（`completed / error / stopped`）后释放。
- 重启恢复：daemon 启动时扫描所有 `Task.status == "queued"` 的任务重新入队 acquire（避免死锁）。

### 4. 任务侧（`services/workflow_runtime.py` + `models/task.py` + `services/schedule.py`）

- `start(project_id, task_id, user_input, source="manual")`：在 `_launch_prepared_run` 之前 acquire 任务槽。
  - 未拿到槽：`task.status = "queued"` 并广播状态事件（AG-UI `CUSTOM workstep.status` / 既有 status 通道），随后 await 槽位；拿到后继续原流程（`status -> running`）。
  - `source` 取值：`manual`（看板/API 手动运行）、`scheduled_start`（定时启动任务）、`schedule`（定时调度任务）。
- `models/task.py`：`Task.status` 注释增加 `queued`；不新增字段（复用现有 status 字段）。
- `services/schedule.py`：`_execute_scheduled_task` / `_execute_run` 调用 `start()` 时传 `source="schedule"` / `scheduled_start`。
- 排队中任务可取消：移出 waiting 队列，状态回 `ready`（可再次手动启动）。
- 任务槽释放点在 `TaskRunner.run_pipeline` 结束（`finally` 中 `task.status` 落定后）。

### 5. 对话侧（`agent_assistants/base.py` + `agent_assistants/chat_session.py`）

- `AssistantRuntime.start_queued_turn()` 前 acquire 对话槽；未拿到槽时 turn 保持 `queued`（现有状态机已支持，仅延长等待），不创建后台任务。
- 排队单位按会话：`submit_message` 时若该会话已有 `queued` turn，合并进原排队项（消息追加，不新增排队位）。
- 对话槽释放点在 `_run_turn` 结束回调（`_consume_background` 中）。
- 排队中可停止：`stop_current` 对 `queued` turn 生效（现有逻辑已覆盖），从等待队列移除。
- 重启恢复：排队中 turn 沿用现有恢复机制（`chat_session.py` 已有 running 快照恢复逻辑），queued turn 在重启后重新排队或按现有恢复策略处理（实施时确定，默认：排队 turn 持久化后重新入队）。

### 6. API

| 接口 | 说明 |
|---|---|
| `GET /api/assistant/concurrency` | 返回全局并发配置 |
| `PUT /api/assistant/concurrency` | 保存全局并发配置 |
| `GET /api/projects/{project_id}/settings/concurrency` | 返回项目并发配置 + 全局值（供 UI 显示「跟随全局 (3)」） |
| `PUT /api/projects/{project_id}/settings/concurrency` | 保存项目并发配置（`null` = 回退全局） |
| `GET /api/projects/{project_id}/settings` | 项目配置弹窗聚合读取（常规 + 对话助手 + 并发限制 + 分享） |

## 前端设计

### 1. 入口

- `TaskList.tsx` / `ChatPage.tsx` Title 工具栏末尾新增 `⚙ 配置` 按钮（图标 + 文字）。
- 点击打开 `ProjectSettingsPanel`（新增组件，弹层，主从导航布局）。

### 2. 弹窗（新增 `ProjectSettingsPanel.tsx`）

- 布局：左侧索引栏（~158px，点击切换、选中高亮）+ 右侧内容区（头部标题联动 + 内容可纵向滚动）。
- 页签与内容：
  - **常规**：项目名称（输入 + 保存，走 `renameProject`）、项目路径（只读）、新建任务默认引擎（跟随全局）。
  - **对话助手**：全局提示词（Markdown 编辑，从 ChatPage 弹框迁移）、快捷按钮（列表编辑，从 ChatPage 弹框迁移）。
  - **并发限制**：任务并发数、对话并发数（数字输入，支持「跟随全局 (n)」/ 自定义）、定时任务不受限制（开关），保存/重置为跟随全局。
  - **分享**：访问类型、访问有效期、生成分享链接、已授权设备列表（从现有 `ProjectShareDialog` 内容迁移）。
- 复用现有组件：`Field` / `Input` / `Select` / `Button` / `MarkdownEditor` / `ConfirmDialog`（未保存改动关闭时确认）。
- 遵循 AGENTS.md 前端规范：禁用原生 alert/confirm、必填校验、无改动遮罩点击直接关闭。

### 3. 状态展示

- `TaskList.tsx`：`STATUS_LABEL_KEYS` / `STATUS_COLORS` 增加 `queued`（「排队中」），看板卡片显示排队位置 `#n`。
- 会话列表（`Layout.tsx` 聊天侧栏 / `ChatPage`）：排队中 turn 显示排队状态与位置。
- i18n：`zh-CN.ts` / `zh-TW.ts` / `ja-JP.ts` / `en-US.ts` 同步新增键。

## 涉及文件

**后端**

- `services/concurrency.py`（新增）
- `services/project_settings.py`（新增）
- `services/config.py`
- `services/workflow_runtime.py`
- `services/schedule.py`
- `agent_assistants/base.py`
- `agent_assistants/chat_session.py`（如需）
- `models/task.py`
- `api/assistant.py`
- `api/project_settings.py`（新增）
- `tests/test_concurrency_gate.py`（新增）+ 排队/豁免/重启恢复用例

**前端**

- `ProjectSettingsPanel.tsx`（新增）
- `TaskList.tsx` / `ChatPage.tsx` / `Layout.tsx`
- `api/client.ts`
- `i18n/*`

## 验收标准

1. `max_tasks=3` 时 4 个任务：前 3 个 `running`，第 4 个 `queued`（看板「排队中 #1」）；任一任务完整结束（含审核/返工）后第 4 个自动启动。
2. `max_chats=3` 时第 4 个会话发消息：turn `queued`，前序会话回复结束后自动启动；任务通道全空也不影响对话排队。
3. `schedule_exempt=true`：定时任务无视任务限制直接运行，不占槽、不排队。
4. 项目未配置时沿用全局；全局未配置时无限；修改限制只影响新请求，不中断已运行。
5. 取消排队任务/停止排队对话立即释放；重启 daemon 后 `queued` 任务恢复排队。
6. 默认（不配置）时行为与现状完全一致。
7. 项目配置弹窗 4 页签可正常读写；聊天页系统提示词/快捷按钮入口收敛后原有功能不丢。

## 边界与降级

- 任务限制是任务维度：任务内 DAG 并行 step 不受影响；如需限制引擎进程总数，后续可增加第三通道。
- 降低限制不中断已运行实例，仅影响新请求；提高限制立即唤醒排队项。
- 分享邀请/授权设备数据保持现有存储（全局 config `remote_access`），本方案只做入口收敛，不迁移数据。
- 项目名称改名走现有 `renameProject`，不改磁盘目录；`project_settings` 现有 key（系统提示词、快捷按钮）不迁移、不重建。

## 实现与验证记录（2026-09-07）

### 后端（已完成）

- `services/config.py`：`get_concurrency_config()` / `set_concurrency_config()`，`concurrency` 段（0=不限制，schedule_exempt 布尔）。
- `services/concurrency.py`（新增）：`ConcurrencyGate` 单例，任务/对话双通道、按项目分桶、FIFO（deque + Future）、定时豁免、排队取消、`effective_config` / `active_count` / `reset` / `configure` / `set_project_config` / `drop_project`。
- `services/project_settings.py`（新增）：`project_settings` 表新 key `concurrency`（全 null 删除行；`set_concurrency_sync` 用 `create()` 显式 INSERT——`ProjectSetting` 为非自增文本主键，`save()` 走 UPDATE 0 行静默失败，已修复）；`sync_all_project_configs` 启动时经 `run_db` 逐项目推送 gate。
- `services/workflow_runtime.py`：`start(..., source=)` 接入闸门（GRANTED/QUEUED/ALREADY_ACTIVE），排队置 `queued` 状态并 `wait_task_slot`（取消时回 `ready`）；`cancel_queued` / `requeue_queued_tasks`（启动恢复）；`_mark_task_status` 附带 `queue_position`；`_execute` finally 释放任务槽。
- `services/task_creation.py` / `services/schedule.py`：`source` 透传（manual / schedule / scheduled_start）。
- `agent_assistants/base.py`：`start_queued_turn` 经对话闸门，排队期间 turn 保持 `queued`，结束释放。
- `api/assistant.py`：`GET/PUT /api/assistant/concurrency`。
- `api/project_settings.py`（新增）：`GET/PUT /api/projects/{id}/settings/concurrency`（global/project/effective 三段）、`GET /api/projects/{id}/settings?with_share=`（常规+对话助手+并发聚合）。
- `main.py`：lifespan 加载全局 + 全项目覆盖进 gate，启动恢复排队任务。
- `models/task.py`：status 注释补 `queued`。

### 前端（已完成）

- `api/client.ts`：`assistantApi.concurrencyConfig/setConcurrencyConfig`、`projectApi.settings/concurrency/setConcurrency` + 类型。
- `i18n/*`：四语言新增 `status.queued`、`taskList.settings*`、`projectSettings.*` 键集（键一致，i18n.test 通过）。
- `components/ProjectSettingsPanel.tsx`（新增）：苹果式主从导航弹窗，4 页签（常规=项目名/路径、对话助手=全局提示词/快捷按钮、并发限制=项目覆盖+定时豁免+生效值、分享=生成分享+设备列表），保存后即时生效。
- `TaskList.tsx`：`⚙ 配置` 图标+文字入口（记忆按钮后）；`queued` 状态标签/颜色 + 排队位置 `#n`；改名同步 store。
- `ChatPage.tsx`：顶部「快捷按钮/系统提示词」两个按钮收敛进弹窗（删除原编辑 state/弹窗），替换为 `⚙ 配置` 入口。

### 测试与验证

- 新增 `tests/test_concurrency_gate.py`（10 例，含任务 FIFO/分桶/豁免/取消/对话排队集成/同会话直通）；`tests/test_concurrency_api.py`（6 例，全局/项目 round trip/聚合/404/sync）。
- 修复两个实现期问题：`ProjectSetting` 非自增主键 `save()` 静默失败（改 `create()`）；测试间 `config_store` 单例 cache 污染（fixture 清 `_cache`）。
- 回归：后端全量 **977 passed**（`uv run pytest tests/ -q`）；前端 `tsc -b`、`npm test`（382 通过，含 i18n 键集一致性）、`npm run lint`（0 errors）、`npm run build` 全部通过。

### 已知边界

- 任务看板列表刷新时排队任务显示「排队中」（无 #n）；`#n` 仅在排队发生时的状态事件中携带。列表接口未加 queue_position（`_task_to_dict` 无项目上下文）。
- 对话排队时输入框仍可继续发送（新 turn 依次入队），无独立「排队中」横幅提示；排队执行正确性已由测试保证。
- 会话列表/详情接口的 `running` 判定未把 `queued` 纳入（排队 turn 不计为 running）；如需输入框禁用提示，后续增强。
