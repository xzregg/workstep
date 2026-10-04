# 会话分叉与跨引擎上下文交接计划

> 状态：第一版已实现（2026-08-29）。支持从稳定会话尾部分叉；任意消息分叉仍为后续范围。

## 目标

为“会话聊天”增加明确、可预测的分叉语义：

- 同一个引擎且该引擎具备原生分叉能力时，沿用引擎自己的会话分叉能力，生成独立的引擎会话。
- 切换引擎分叉时，绝不把旧引擎的会话 ID 交给新引擎；创建全新会话，并明确询问用户是否载入此前聊天记录。
- 跨引擎上下文使用引擎无关的结构化交接包，而不是简单拼接所有原始事件。
- 分叉后源会话保持不变；新旧会话可以独立继续、停止、删除和恢复。

## 实施前基线（历史）

以下条目记录方案启动前的缺口，不描述当前实现：

- 会话及消息分别持久化在 `chat_sessions` / `chat_messages`，当时还没有父会话、分叉点或交接方式字段。
- `ChatPage` 当时只支持新建、重命名、删除，没有分叉入口。
- `AssistantRuntime._get_or_create_session` 检测到引擎切换时只清空 `resolved_session_id`，仍保留 WorkStep 消息。
- 对支持 resume 的引擎，`ChatSessionModule._build_prompt` 在没有引擎会话 ID 时只发送系统提示词和最后一条用户消息，切换引擎会造成上下文断层。
- 引擎公共能力当时只有 `supports_resume` / `supports_sessions`，没有原生会话分叉接口或能力声明。
- `engine_state` 只适用于能序列化自身历史的进程内引擎，不能作为跨引擎格式直接复用。

## 产品语义

### 入口与分叉点

第一版支持从当前会话尾部进行分叉，入口放在会话页头操作区。分叉成功后直接打开新会话。后续若要支持“从某条消息分叉”，沿用同一后端接口增加 `fork_message_id`，不另建一套实现。

运行中的会话禁止分叉，提示先停止或等待当前回复完成，避免分叉快照与正在写入的消息不一致。

### 分叉弹框

弹框展示：

1. 新会话名称，默认“原名称 · 分支”。
2. 目标引擎及模型，默认沿用当前会话。
3. 上下文方式。

上下文方式根据目标引擎动态呈现：

- **同引擎原生分叉**：默认且不可误解，文案说明“将继承当前引擎上下文，并从此处独立继续”。
- **智能交接（推荐）**：跨引擎默认选项；载入结构化交接包和最近若干轮原文。
- **完整聊天记录**：载入截至分叉点的全部可见用户/助手消息；超出上下文预算时拒绝提交并引导改选“智能交接”，不静默截断。
- **不载入**：建立空白的新引擎会话，只保留项目工作目录，不向目标引擎传递旧聊天内容。

“是否载入此前聊天记录”必须由用户显式确认。跨引擎时默认勾选“智能交接”，但确认按钮旁明确显示将载入的方式、消息数量和估算长度。

### 失败与降级

- 同引擎声明支持原生分叉，但适配器实际失败：不自动退化为历史注入，保留弹框并提示用户改选“智能交接”后重试。
- 同引擎不支持原生分叉：弹框展示“智能交接 / 完整记录 / 不载入”，行为与跨引擎一致。
- 目标引擎不可用或配置无效：分叉前校验并阻止创建半成品会话。
- 本地会话和复制消息采用事务；原生引擎分叉使用“两阶段创建”，失败时隐藏未完成分支并做补偿清理，不能假设外部引擎操作与 SQLite 处于同一事务。

## 后端设计

### 1. 在引擎 seam 增加最小分叉接口

在 `BaseLLMEngine` / `AcpEngineBase` 增加：

```python
@property
def supports_session_fork(self) -> bool: ...

async def fork_session(
    self,
    session_id: str,
    cwd: str,
    *,
    fork_point: str | None = None,
) -> str | None: ...
```

并在 `EngineCapabilities`、引擎列表接口和前端 `EngineInfo` 中暴露 `supports_session_fork`。

约束：

- 只有存在真实引擎能力的 adapter 才返回 `True`，能力声明必须等于实际行为。
- 返回值必须是新的引擎会话 ID，不能复用源 ID。
- 没有原生能力的 adapter 使用基类默认实现 `None`，不模拟“原生分叉”。
- 逐一核对 Codex CLI、Codex SDK、Claude Code/SDK、Hermes ACP、Qoder SDK、Pydantic AI harness 等当前版本；只为确认存在原生 primitive 的引擎实现 adapter。

### 2. 建立统一的会话分叉 module

在 `ChatSessionModule` 暴露一个深接口：

```python
async def fork_session(project_id, source_session_id, request) -> dict
```

由 module 内部完成：源会话校验、稳定快照、策略选择、引擎分叉或上下文编译、新会话落库和结果返回。API、前端和测试都只跨这个 seam，不在调用处复制策略判断。

请求字段：

- `title`
- `engine` / `provider_id` / `model` / `fast_model` / `vision_model`
- `context_mode`: `native | smart | full | none`
- 预留 `fork_message_id`，第一版不传即会话尾部

响应除完整新会话外，返回 `fork_strategy`、`inherited_message_count` 和可展示的提示。

### 3. 数据模型与迁移

给 `chat_sessions` 增加：

- `parent_session_id`：WorkStep 源会话 ID，可空，自关联只保存 ID，不做级联删除。
- `forked_from_message_id`：分叉快照最后一条消息 ID，可空。
- `fork_context_mode`：`native | smart | full | none`，可空以兼容旧数据。
- `fork_context_json`：跨引擎交接包快照，可空；用于审计和恢复，不依赖源会话继续存在。
- `fork_status`：`pending | ready | failed`，普通和旧会话视为 `ready`；列表默认不展示非 `ready` 分支。

不复制源会话的 JSONL 工具/思考事件。需要显示历史时，只复制截至分叉点的可见 `ChatMessage` 行，并为新行生成新 ID；来源关系保存在交接元数据中，避免两个会话共享可变消息或日志路径。

建议新增 migration 并更新迁移结构测试；旧会话字段默认均为空。

### 4. 引擎无关的上下文交接包

新增纯函数 module，例如 `agent_assistants/context_handoff.py`：

```python
compile_handoff(messages, mode, budget) -> HandoffPackage
render_handoff(package) -> str
```

它只读取可见用户/助手消息及已落库产物引用，不读取或传递隐藏思考、权限记录、工具参数、环境变量、引擎内部状态和原始事件日志。

“智能交接”采用确定性结构，至少包含：

- 原始目标与当前最新请求
- 已确认的决定和约束
- 已提及的文件、产物和命令结果引用
- 尚未解决的问题与下一步
- 最近若干轮用户/助手原文
- 来源会话 ID、分叉点和“必要时重新检查项目文件，不要把摘要当作事实”的提示

第一版不再调用一个 LLM 生成摘要，避免分叉额外花费、延迟和不可复现。使用规则提取 + 最近消息原文；后续可在相同接口内部增加可选的模型压缩 adapter。

目标引擎的首次调用按能力选择传递方式：

- `supports_message_history=True`：把标准化 user/assistant 消息作为 `message_history` 种子，并让引擎报告新的 `engine_state`。
- 仅支持 resume 的新引擎：创建新会话，在首次 prompt 前加入一次性的 `<workstep_context_handoff>` 结构化块；后续轮次只走新引擎的 resume。
- 无状态引擎：继续通过现有历史构建逻辑传递新分支的消息。
- `none`：三类引擎都不注入源消息或源 `engine_state`。

为避免交接块在后续每轮重复注入，给新会话增加一次性 `pending_handoff` 运行态，首次成功调用后清除；若调用失败则保留以便重试。持久化快照保证 daemon 重启后仍能完成首次交接。

### 5. 原生分叉流程

同引擎 + `supports_session_fork=True` + 源 `engine_session_id` 存在时：

1. 校验源会话没有运行中的 turn。
2. 在本地事务中创建 `pending` 的 WorkStep `ChatSession` 和消息快照，不向列表展示。
3. 调用源引擎 adapter 的 `fork_session`，得到新的引擎会话 ID。
4. 在第二个本地事务中保存新的 `engine_session_id` 并改为 `ready`；不得复制源 `engine_state`。
5. 新分支下一轮直接 resume 新 ID，源分支继续 resume 旧 ID。
6. 原生调用失败时删除本地 `pending` 分支；本地 finalize 失败时尽力调用引擎关闭/删除新会话，并由启动恢复清理残留 `pending` 行。无法删除的引擎侧孤立会话只记录日志，绝不影响源会话。

如果源会话还没有 `engine_session_id`（从未成功发送消息），直接建立同配置空会话，策略记为 `none`，无需调用引擎分叉。

### 6. 修正普通“切换引擎”的歧义

已有会话的引擎选择器不应在下一次发送时静默切换：

- 有历史的会话选择另一引擎时，弹出分叉弹框并走上述流程。
- 空会话允许直接修改引擎配置。
- 如果产品仍需“原地换引擎”，必须复用同一上下文选择弹框并显式清空旧 `engine_session_id` / `engine_state`；第一版不提供该入口，减少不可逆的会话身份混杂。

同时修正 `AssistantRuntime`：引擎发生变化时一并清空不兼容的 `engine_state`，不能只清空 `resolved_session_id`。

## API 与前端改造

### API

新增：

```text
POST /api/chat-sessions/{session_id}/fork
```

请求体包含 `project_id` 及上述分叉参数。错误约定：不存在 `404`、源会话运行中 `409`、能力或上下文预算校验失败 `400/422`、原生 adapter 失败返回可识别错误码以便前端建议改用智能交接。

可在打开弹框时使用已下发的引擎 capability；最终选择必须由后端再次校验，不能信任前端。

### 前端

- `ChatPage` 页头新增“分叉”按钮，运行中禁用并显示原因。
- 新增可复用 `ChatSessionForkDialog`，使用现有 `ConfirmDialog`、引擎配置组件和表单样式。
- 对已有历史的会话切换引擎时打开同一个弹框，不直接更改当前会话。
- 弹框根据“目标引擎是否与源引擎一致 + capability”选择默认模式并显示解释。
- 创建期间显示持续旋转状态；成功后更新侧栏 store、订阅新 session channel 并导航到新会话。
- 源会话与新会话标题附近显示轻量来源提示；可点击返回源会话，但删除源会话后仍可正常查看分支。
- 新增文案先写 `zh-CN.ts`，同步补齐 `en-US`、`ja-JP`、`zh-TW` 键集合。

## TDD 实施顺序

### 阶段一：能力接口

1. 先在 `test_engine_base_hierarchy.py` 增加默认不支持、能力声明一致、真 adapter 返回独立 ID 的测试。
2. 增加实际支持引擎的 adapter 测试，包括参数传递、错误和不复用源 ID。
3. 实现 `supports_session_fork` / `fork_session` 及 registry 输出。

验证：引擎能力测试和相关引擎测试通过。

### 阶段二：数据与交接包

1. 先写 migration 测试与 `context_handoff` 纯函数测试。
2. 覆盖 smart/full/none、长度预算、隐藏事件排除、最近轮保留、源会话删除后快照仍可用。
3. 实现字段、迁移和交接包 module。

验证：迁移、序列化、敏感内容排除测试通过。

### 阶段三：后端分叉流程

1. 在 `test_chat_session.py` 先覆盖：
   - 同引擎原生分叉产生不同引擎会话 ID。
   - 源分支与新分支后续 resume 各自 ID。
   - 跨引擎 smart/full/none 的首次调用内容。
   - 新引擎永远不会收到旧引擎 session ID / engine state。
   - 失败事务回滚、运行中 409、幂等或重复提交保护。
   - 重启后 pending handoff 仍只注入一次。
2. 实现 `ChatSessionModule.fork_session` 和 API route。
3. 修正普通引擎切换时清空不兼容状态的行为。

验证：chat session、assistant runtime、API contract 测试通过。

### 阶段四：前端交互

1. 先补前端测试：弹框默认项、跨引擎提醒、空会话直接换引擎、运行中禁用、成功导航和失败不切页。
2. 实现 API 类型、store 更新、`ChatSessionForkDialog` 和 `ChatPage` 接入。
3. 补齐 i18n 文案并检查弹框尺寸、键盘操作和焦点。

验证：相关前端测试、i18n 测试和构建通过，并人工核对桌面/窄屏交互。

### 阶段五：文档

- 更新 `docs/architecture.md` 的会话生命周期，区分 resume、native fork、history handoff。
- 更新 `docs/architecture.md` 中普通会话的已实现能力和接口。
- 如引擎支持矩阵发生变化，同步 AGENTS.md 的多引擎表述，仅写已验证事实。

## 验收标准

- 同引擎原生分叉后，新旧分支的 WorkStep session ID 和引擎 session ID 均不同，继续对话互不影响。
- 跨引擎分叉前必须看到是否载入历史的选择；默认“智能交接”，用户可以明确选“完整记录”或“不载入”。
- 新引擎不会收到旧引擎的 session ID、私有 `engine_state`、思考过程或工具事件。
- 智能交接包含目标、决定、约束、待办和最近对话，并有稳定预算；完整记录超预算时不静默丢失。
- 首次交接只注入一次；失败重试和 daemon 重启不会丢失或重复消费。
- 分叉失败不改变源会话，不留下半成品数据。
- 有历史的会话不再通过选择器静默原地切换引擎。
- 后端、前端、i18n 和迁移测试全部通过。

## 明确不做

- 第一版不支持从任意一条历史消息分叉，只从当前稳定尾部开始，但数据与接口预留分叉点。
- 不复制隐藏思考、完整工具调用日志或旧引擎私有状态到新引擎。
- 不用另一个 LLM 自动总结交接内容。
- 不让前端自行拼接历史 prompt；所有交接策略集中在后端 module。
