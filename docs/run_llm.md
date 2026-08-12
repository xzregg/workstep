# Open Design 调用本地 LLM 引擎流程

## 总体架构

```
Web 前端 (apps/web)
  ↓ fetch('/api/runs') 带完整对话 transcript
Daemon (apps/daemon/src/server.ts)
  ↓ spawn 子进程 + stdin/stdout 管道
本地 CLI (claude / codex / hermes)
  ↓ JSONL / JSON-RPC 事件流
Daemon 解析 → SSE 推送到 Web
```

### 统一入口

Web 端 `buildDaemonTranscript(history)` 将对话历史序列化为 markdown：

```
## user
用户消息

## assistant
助手回复
```

POST 到 `/api/runs`，daemon 拼接成最终 prompt（指令块 + transcript + 最新请求），通过子进程 stdin 发送给 CLI。

---

## Claude Code

### 命令

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \     # 能力探测成功后
  --model <model> \                # 可选
  --add-dir <path> \               # 可选，可多个
  --session-id <uuid> \            # 首轮：新会话
  --resume <sessionId> \           # 后续轮：恢复会话
  --permission-mode bypassPermissions
```

- 二进制解析优先级：`CLAUDE_BIN` 环境变量 → PATH `claude` → 回退 `openclaude`
- 定义：`apps/daemon/src/runtimes/defs/claude.ts`
- 流解析：`apps/daemon/src/claude-stream.ts`（`streamFormat: 'claude-stream-json'`）

### stdin 协议（JSONL 流，保持打开）

初始 prompt：
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

**stdin 不关闭**，后续可注入 `tool_result`（回答 AskUserQuestion）：
```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"xxx","content":"用户选择","is_error":false}]}}
```

关闭时机：回合干净结束（`turn_end` 且 `stop_reason !== 'tool_use'`）且无待处理主机回答时，才 `stdin.end()`。

### 历史上下文

| 场景 | 参数 | prompt 内容 | 上下文来源 |
|------|------|------------|-----------|
| 首轮 | `--session-id <uuid>` | 完整 transcript + 最新请求 | Web 序列化历史 |
| 后续轮 | `--resume <sessionId>` | 仅最新请求 | Claude 自身会话文件 |

会话 ID 持久化在 SQLite `agent_sessions` 表。稳定指令块（系统 prompt + 工具契约）通过 hash 指纹判断是否变化，未变化时跳过重发。

### stdout 事件映射

| Claude 输出 | 内部事件 |
|---|---|
| `system/init` | `status: initializing` |
| `stream_event` → `content_block_delta` (text) | `text_delta` |
| `stream_event` → `content_block_delta` (thinking) | `thinking_delta` |
| `stream_event` → `content_block_delta` (input_json) | `tool_use` / `tool_input_delta` |
| `assistant` (完整消息) | 遍历 content 块 |
| `TodoWrite` / `TaskCreate` / `TaskUpdate` / `TaskList` | Base 聚合为 `plan` 快照 |
| `result` | `usage` |
| `user` (含 tool_result) | `tool_result` |

### 环境变量处理

- 移除 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN`（除非设了 `ANTHROPIC_BASE_URL` 自定义端点）
- 确保 Claude Code 使用自身的 `claude login` 认证

---

## Codex CLI

### 命令

```bash
# macOS/Linux
codex exec --json --skip-git-repo-check \
  --sandbox workspace-write \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'default_permissions=":workspace"' \
  -C /path/to/cwd \
  --add-dir /extra/path \
  --model gpt-5.5 \
  -c 'model_reasoning_effort="high"'

# Windows/WSL（无可用沙箱）
codex exec --json --skip-git-repo-check \
  --sandbox danger-full-access \
  -c 'default_permissions=":workspace"' \
  ...
```

- 定义：`apps/daemon/src/runtimes/defs/codex.ts`
- 流解析：`apps/daemon/src/json-event-stream.ts`（`streamFormat: 'json-event-stream'`, `eventParser: 'codex'`）

### stdin 协议（纯文本，写完关闭）

整个 prompt 作为纯文本写入 stdin，然后立即 `stdin.end()`。没有交互能力。

### 历史上下文

**无会话恢复**。每轮都是：
1. Web 序列化完整 transcript
2. Daemon 拼接 prompt（指令 + transcript + 最新请求）
3. 全量通过 stdin 发送

### stdout 事件映射

| Codex 事件 | 内部事件 |
|---|---|
| `thread.started` | `status: initializing` |
| `turn.started` | `status: running` |
| `turn.plan.updated` / SDK `turn/plan/updated` | `plan` |
| `item.started` (command_execution) | `tool_use` (name: "Bash") |
| `item.completed` (command_execution) | `tool_result` |
| `item.completed` (agent_message) | `text_delta` |
| `turn.completed` | `usage` |
| `error` / `turn.failed` | `error` |

工具只有一种：`command_execution`（shell 命令），统一映射为 `Bash`。

### 沙箱策略

| 平台 | 沙箱模式 |
|------|---------|
| macOS (Seatbelt) | `workspace-write` |
| Linux (Landlock+seccomp) | `workspace-write` |
| Windows / WSL | `danger-full-access` |

可通过 `OD_CODEX_SANDBOX=danger-full-access` 强制覆盖。

---

## Hermes (ACP 协议)

### 命令

```bash
hermes acp --accept-hooks
```

- 定义：`apps/daemon/src/runtimes/defs/hermes.ts`
- 会话管理：`apps/daemon/src/acp.ts`（`streamFormat: 'acp-json-rpc'`）

### 通信协议：JSON-RPC 双向握手

完整生命周期（6 个阶段）：

#### 1. 初始化

```
Daemon → Hermes:
  { jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientInfo: { name: "open-design" } } }
```

#### 2. 创建会话

```
Daemon → Hermes:
  { jsonrpc: "2.0", id: 2, method: "session/new",
    params: { cwd: "/project/path", mcpServers: [...] } }

Hermes → Daemon:
  { jsonrpc: "2.0", id: 2, result: { sessionId: "abc", configOptions: [...] } }
```

#### 3. 设置模型（可选）

```
Daemon → Hermes:
  { jsonrpc: "2.0", id: 3, method: "session/set_model",
    params: { sessionId: "abc", modelId: "grok-4.3" } }
```

#### 4. 发送 prompt

```
Daemon → Hermes:
  { jsonrpc: "2.0", id: 4, method: "session/prompt",
    params: { sessionId: "abc",
              prompt: [{ type: "text", text: "...完整prompt..." }] } }
```

#### 5. 流式响应（Hermes 推送）

```
Hermes → Daemon (通知，无 id):
  { method: "session/update",
    params: { update: { sessionUpdate: "agent_thought_chunk",
                        content: { text: "思考中..." } } } }

  { method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk",
                        content: { text: "回复文本..." } } } }

  { method: "session/update",
    params: { update: { sessionUpdate: "tool_call", ... } } }
```

#### 6. 权限请求（反向）

```
Hermes → Daemon:
  { id: 99, method: "session/request_permission",
    params: { options: [{ optionId: "approve_for_session" }] } }

Daemon → Hermes:
  { id: 99, result: { outcome: { outcome: "selected",
                                   optionId: "approve_for_session" } } }
```

Daemon 将完整 `options` 转换为统一 `interaction_request` 并暂停当前执行；用户选择后，按原 `optionId` 返回 ACP `selected` 结果，拒绝或取消不会被转换成允许。

### 历史上下文

**无会话恢复**。每轮全量 transcript 通过 `session/prompt` 发送。ACP 会话仅存在于单次 run 生命周期内。

### stdout 事件映射

| ACP update 类型 | 内部事件 |
|---|---|
| `agent_thought_chunk` | `thinking_start` + `thinking_delta` |
| `agent_message_chunk` | `text_delta`（增量去重） |
| `plan` | `plan`（ACP stable 完整快照） |
| `tool_call` / `tool_call_update` | 标记 `emittedToolCall` |
| prompt 完成 `result.usage` | `usage` |

### 结束处理

prompt 完成后 `stdin.end()`，给 500ms 宽限期，不退出则 SIGTERM。

---

## 三者对比

| 维度 | Claude Code | Codex CLI | Hermes |
|------|------------|-----------|--------|
| 命令 | `claude -p --input-format stream-json ...` | `codex exec --json ...` | `hermes acp --accept-hooks` |
| stdin 协议 | JSONL 流（保持打开） | 纯文本（写完关闭） | JSON-RPC 双向（保持打开） |
| stdout 协议 | JSONL (Anthropic events) | JSONL (thread/turn events) | JSON-RPC (session/update) |
| 会话恢复 | `--resume` / `--session-id` | 无 | 无 |
| 历史传递 | 首轮 transcript，后续靠自身记忆 | 每轮全量 transcript | 每轮全量 transcript |
| 交互能力 | AskUserQuestion / 权限确认 | 无 | ACP 权限确认与表单询问 |
| 工具模型 | 完整工具集 | 仅 shell (Bash) | ACP tool_call |
| 流解析器 | `claude-stream.ts` | `json-event-stream.ts` | `acp.ts` |
| streamFormat | `claude-stream-json` | `json-event-stream` | `acp-json-rpc` |

## 供应商（Provider）SSRF 防护

WorkStep 的供应商设置允许自定义 `base_url`（DeepSeek / Kimi / OpenAI / Anthropic / Ollama / 自定义）。保存时经 `validate_api_base_url`（`engines/core/schema.py`）校验：

- 远程地址必须使用 HTTPS；
- 仅允许 HTTPS 或本机回环地址（`127.x.x.x` / `localhost` / `::1`）使用 HTTP，供 Ollama 等本地模型运行器使用；
- 校验失败时拒绝保存并给出明确错误。

供应商的 API Key 存于 `~/.workstep/config.json`（文件权限 `0600`），列表与配置接口返回时一律掩码，读取需经显式 reveal 接口。
---

## 提示词和返回结果的记录

Open Design 在 **四个层级** 记录 LLM 的提示词和返回结果：

```
┌─────────────────────────────────────────────────────────┐
│  1. 内存 Run 注册表 (runs.ts)                            │
│     events[] 数组，最多 2000 条，SSE 实时推送到前端         │
│     TTL 30 分钟后自动清理                                  │
├─────────────────────────────────────────────────────────┤
│  2. 磁盘 JSONL 日志 (runsLogDir)                         │
│     .od/runs/<runId>/events.jsonl                        │
│     每个事件一行 JSON，永久保留                              │
├─────────────────────────────────────────────────────────┤
│  3. SQLite messages 表 (db.ts)                           │
│     events_json 列：JSON 数组，所有 agent 事件             │
│     content 列：拼接所有 text_delta 为完整回复文本           │
│     永久保留，支持历史对话回溯                               │
├─────────────────────────────────────────────────────────┤
│  4. Langfuse 外部追踪 (langfuse-bridge.ts)                │
│     run 完成后上报：prompt、model、token 用量、事件摘要      │
│     可选，用于可观测性分析                                  │
└─────────────────────────────────────────────────────────┘
```

### 层级 1：内存 Run 注册表

`apps/daemon/src/runs.ts` 的 `createChatRunService`。

每个 run 对象在内存中持有：

```js
const run = {
  id,                              // UUID
  projectId, conversationId,       // 关联
  assistantMessageId,              // 对应 SQLite messages 表
  agentId,                         // 'claude' / 'codex' / 'hermes'
  status: 'queued',                // → running → succeeded/failed
  events: [],                      // 事件数组，最多 2000 条
  nextEventId: 1,                  // 递增 ID
  child: null,                     // 子进程引用
  acpSession: null,                // ACP 会话引用
  userPrompt: '...',               // 用户原始输入（telemetry 用）
  promptTelemetry: {...},          // prompt 各部分拆分
  eventsLogPath: '.od/runs/<id>/events.jsonl',
};
```

**事件写入**（`runs.emit`）：
```js
const emit = (run, event, data) => {
  const record = { id: run.nextEventId++, event, data, timestamp: Date.now() };
  run.events.push(record);                        // 内存
  if (run.events.length > 2000) run.events.splice(0, ...); // 截断
  stream.write(JSON.stringify(record) + '\n');     // 磁盘 JSONL
  for (const sse of run.clients) sse.send(event, data, id); // SSE 推送
};
```

事件类型包括：`agent`（text_delta/tool_use/tool_result/usage 等）、`error`、`start`、`end`、`stdout`、`stderr`。

### 层级 2：磁盘 JSONL 日志

路径：`.od/runs/<runId>/events.jsonl`

每个事件一行：
```json
{"id":1,"event":"agent","data":{"type":"status","label":"initializing","model":"claude-sonnet-4-5"},"timestamp":1718000000000}
{"id":2,"event":"agent","data":{"type":"text_delta","delta":"你好"},"timestamp":1718000000100}
{"id":3,"event":"agent","data":{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}},"timestamp":1718000000200}
{"id":4,"event":"agent","data":{"type":"tool_result","toolUseId":"tu_1","content":"file1.txt\nfile2.txt"},"timestamp":1718000000300}
{"id":5,"event":"agent","data":{"type":"usage","usage":{"input_tokens":1500,"output_tokens":200}},"timestamp":1718000000400}
{"id":6,"event":"end","data":{"code":0,"signal":null,"status":"succeeded"},"timestamp":1718000000500}
```

run 结束后文件保留在磁盘上，可通过 MCP `get_run` 获取路径让外部 agent `tail` 查看。

### 层级 3：SQLite messages 表

`apps/daemon/src/db.ts`，表结构：

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,     -- 对话 ID
  role TEXT NOT NULL,                -- 'user' / 'assistant'
  content TEXT NOT NULL,             -- 用户输入或拼接的回复文本
  agent_id TEXT,                     -- 'claude' / 'codex' / 'hermes'
  agent_name TEXT,                   -- 'Claude Code' 等
  run_id TEXT,                       -- 关联的 run ID
  run_status TEXT,                   -- 'succeeded' / 'failed'
  events_json TEXT,                  -- ⭐ 所有 agent 事件的 JSON 数组
  attachments_json TEXT,             -- 附件
  produced_files_json TEXT,          -- 生成的文件
  feedback_json TEXT,                -- 用户反馈
  session_mode TEXT,                 -- 'design' / 'chat'
  started_at INTEGER,
  ended_at INTEGER,
  position INTEGER NOT NULL,         -- 对话中的顺序
  created_at INTEGER NOT NULL
);
```

**关键字段**：

| 字段 | 内容 | 写入时机 |
|------|------|---------|
| `content` | 用户原始输入（role=user）或所有 text_delta 拼接（role=assistant） | 创建时 / 每个 text_delta 追加 |
| `events_json` | 所有 agent 事件的 JSON 数组 | 每个事件实时追加 |
| `run_id` | 关联的 run UUID | 创建时 |
| `run_status` | 最终状态 | run 结束时更新 |

**写入流程**（`server.ts:2704` `persistRunEventToAssistantMessage`）：

```
agent stdout 事件
  → 流解析器转换为内部事件 (text_delta / tool_use / ...)
    → runs.emit() → SSE 推送给前端
                  → events.jsonl 磁盘写入
                  → persistRunEventToAssistantMessage()
                    → appendMessageAgentEvent()
                      → UPDATE messages SET
                           content = content || delta,    -- 拼接文本
                           events_json = [...events, event] -- 追加事件
```

**事件转换**（`server.ts:2743` `daemonAgentPayloadToPersistedAgentEvent`）：

| 内部事件 | 持久化 kind | 存储内容 |
|---------|-----------|---------|
| `text_delta` | `text` | `{ kind: 'text', text: delta }` |
| `thinking_delta` | `thinking` | `{ kind: 'thinking', text: delta }` |
| `tool_use` | `tool_use` | `{ kind: 'tool_use', id, name, input }` |
| `tool_result` | `tool_result` | `{ kind: 'tool_result', toolUseId, content, isError }` |
| `usage` | `usage` | `{ kind: 'usage', inputTokens, outputTokens, costUsd, durationMs }` |
| `status` | `status` | `{ kind: 'status', label, detail }` |
| `tool_input_delta` | 不持久化 | 仅实时显示用 |

### 层级 4：Langfuse 外部追踪

`apps/daemon/src/langfuse-bridge.ts`，run 完成后一次性上报。

上报内容：
- **prompt**：用户原始输入（`run.userPrompt`）
- **model**：使用的模型 ID
- **token 用量**：input_tokens / output_tokens / cache_tokens
- **事件摘要**：tool_calls 数量、errors 数量、duration
- **metadata**：agent_id、skill_id、design_system_id、client_type (desktop/web)
- **对话历史**：从 SQLite 加载该对话的所有消息

可选功能，需要配置 Langfuse endpoint 才启用。

### Prompt 记录

**完整 prompt 不直接存入 messages 表**。提示词各部分通过 `run.promptTelemetry` 拆分记录在内存 run 对象上：

```js
run.promptTelemetry = {
  parts: [
    { kind: 'daemonSystemPrompt', content: '...' },
    { kind: 'runtimeToolPrompt', content: '...' },
    { kind: 'skillPrompt', content: '...' },
    { kind: 'designSystemPrompt', content: '...' },
    { kind: 'userRequest', content: '...' },
    ...
  ],
  composedPrompt: '...完整拼接后的 prompt...',
};
```

这个对象只在内存中存活，用于 Langfuse 上报时引用。`run.userPrompt` 存储用户原始输入文本，也仅用于分析追踪。

### 查询示例

读取某次对话的完整事件流：
```sql
SELECT role, content, events_json, agent_id, run_status
FROM messages
WHERE conversation_id = 'xxx'
ORDER BY position;
```

查看某次 run 的事件日志：
```bash
cat .od/runs/<runId>/events.jsonl | jq .
```

---

## Claude Code 工具调用解析与前端渲染

以截图中 "正在读取 1 个文件…"、"读取文件"、"编辑文件"、"运行命令" 为例，完整链路如下。

### 1. Daemon 侧：`claude-stream.ts` 三段式解析

Claude Code 以 `content_block_start` / `content_block_delta` / `content_block_stop` 三个事件描述一个完整的 content block（文本或工具调用）。parser 维护 `blocks: Map<string, BlockState>`，按 `index` 键跟踪：

```
content_block_start  (index=0, type=tool_use, name="Read", id="toolu_xxx")
  → blocks.set("0", { type: "tool_use", id, name, input: "" })

content_block_delta  (index=0, delta={ type: "input_json_delta", partial_json: "{\"file_path\":\"/..." })
  → state.input += partial_json
  → emit({ type: "tool_input_delta", id, name, delta })   ← 实时，不持久化

content_block_stop   (index=0)
  → JSON.parse(state.input)
  → emit({ type: "tool_use", id, name, input: { file_path: "/..." } })   ← 完整，持久化
```

`tool_input_delta` 用于驱动前端实时状态文案（"正在读取…"），`tool_use` 是最终结果，写入磁盘和 SQLite。

### 2. 内部事件类型对照

| Claude 流事件 | 内部事件 kind | 是否持久化 |
|---|---|---|
| `text_delta` | `text` | 是，追加到 `messages.content` |
| `thinking_delta` | `thinking` | 是，追加到 `events_json` |
| `input_json_delta` | `tool_input_delta` | **否**，仅实时 SSE |
| `content_block_stop`（tool_use block） | `tool_use` | 是 |
| `user`（含 tool_result） | `tool_result` | 是 |

### 3. 前端分组折叠（`AssistantMessage.tsx`）

`groupConsecutiveToolItems()` 将连续同类工具调用合并为一组，按 `toolFamily()` 分类：

```ts
toolFamily("Read")              → "read"
toolFamily("Edit")              → "edit"
toolFamily("Write")             → "write"
toolFamily("Bash")              → "bash"
toolFamily("WebFetch")          → "fetch"
toolFamily("TodoWrite")         → "todo"
```

同 family 连续调用折叠成单个 `ToolGroup` pill，显示格式：`Editing ×3, Done`。

### 4. 状态文案（`verbForState`）

每个 tool item 根据是否有 `tool_result` 决定状态文案：

| 阶段 | 显示文案 |
|---|---|
| 只有 `tool_input_delta`，无完整 `tool_use` | 正在读取… / 正在编辑… / 正在运行… |
| 有 `tool_use`，run 仍在运行 | 读取中 / 编辑中 / 运行中 |
| 有 `tool_result` | Done |

多个同类合并：`Reading ×3, Done`；混合状态：`Editing, Reading, Done`。

### 5. 工具卡片渲染（`ToolCard.tsx`）

`ToolCard` 按工具 `name` 选择渲染方式：

| name | 渲染 |
|---|---|
| `Read` / `read_file` | 文件路径 + ↗ 图标 |
| `Edit` / `str_replace_edit` | diff 视图 + ✎ 图标 |
| `Write` / `create_file` | 新建文件 + + 图标 |
| `Bash` | 命令文本 + $ 图标 |
| `WebFetch` / `WebSearch` | URL + ↬ 图标 |
| `TodoWrite` | 任务列表 + ☐ 图标 |

图标来自 `familyIcon(family)`。

### 6. 完整渲染链路

```
Claude stdout: content_block_delta (input_json_delta)
  → claude-stream.ts 解析
    → emit tool_input_delta (SSE)
      → 前端实时更新状态文案 "正在读取 1 个文件…"

Claude stdout: content_block_stop
  → claude-stream.ts JSON.parse(input)
    → emit tool_use (SSE + 磁盘 + SQLite)
      → 前端渲染 ToolCard：显示具体文件路径/命令内容
      → 状态文案切换为 "读取文件" / "编辑文件" / "运行命令"

Claude stdout: user (含 tool_result)
  → emit tool_result (SSE + 磁盘 + SQLite)
    → 前端状态切换为 "Done" / "完成"
```
