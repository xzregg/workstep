# WorkStep · 产品需求文档 (PRD)

> 本地 LLM 驱动的研发工作流编排工具。把"需求 → 设计 → 前端 → 后端 → 测试 → 上线"串成可编排的管道，每个阶段调用合适的本地 LLM 引擎（Claude Code / Codex CLI / Hermes ACP）完成作业，全程流式可见、可干预、可回溯。

---

## 1. 概述

### 1.1 产品定位

WorkStep 是一个面向小团队 / 独立开发者的 **本地优先 (local-first) 工作流编排工具**。它不是另一个 Chat UI，而是把任意多步骤流程抽象成一条可编排的管道：每个步骤是一个可配置的 LLM 任务节点，节点之间通过产物（文档、设计稿、代码、报告）衔接，由本地 LLM 引擎执行。工具本身不限定流程类型——**默认内置研发流程模板**（需求 → 设计 → 前端 → 后端 → 测试 → 上线），但用户可自由增删步骤、重排顺序，定义写作、数据、运营等任意管道。打开任意项目时，会在项目根目录生成 `.workstep/` 目录，存放节点编排配置与各步骤产物。

### 1.2 目标用户

- 独立开发者 / 小团队（1–5 人）
- 已在本地装好 Claude Code / Codex / Hermes 等 CLI
- 有重复性的多步骤工作流（研发 / 写作 / 数据 / 运营），希望"用 AI 把它从输入跑到产物"，但不愿手动在多个工具间复制粘贴

### 1.3 核心价值

| 价值 | 说明 |
|------|------|
| **多引擎统一定义** | Claude / Codex / Hermes 三种协议（JSONL 流 / 纯文本 / JSON-RPC）统一抽象为同一套内部事件，用户不感知差异 |
| **流程即代码** | 任意步骤、提示词、I/O 接口、连接条件均可在画布上拖拽编排，存为 `.workstep/steps.json`；内置研发模板只是起点，管道完全由用户定义 |
| **本地优先 + 数据自主** | LLM 调用、会话历史、产物文件全部留在本地 |
| **流式可干预** | SSE 推送每一步思考 / 工具调用 / 产物，中途可注入 `tool_result` 或响应权限请求 |

### 1.4 非目标 (Non-Goals)

- 不做云端 LLM 托管（用户自带 CLI 与认证）
- 不做团队协作 / 多人实时编辑（v1 单机）
- 不替代 Figma / IDE，只编排它们之间的衔接

---

## 2. 核心技术

以下六项是 WorkStep 的技术底座，PRD 的功能需求都建立在此基础上。

### 2.1 多 LLM 引擎统一抽象

三种引擎通过 `streamFormat` 字段统一在 Daemon 的 `runtimes/defs/` 下：

| 引擎 | 命令 | stdin 协议 | stdout 协议 | 会话恢复 | 工具模型 |
|------|------|-----------|------------|---------|---------|
| Claude Code | `claude -p --input-format stream-json ...` | JSONL 流（保持打开） | JSONL (Anthropic events) | `--resume` / `--session-id` | 完整工具集 |
| Codex CLI | `codex exec --json --skip-git-repo-check ...` | 纯文本（写完关闭） | JSONL (thread/turn events) | 无 | 仅 shell (Bash) |
| Hermes | `hermes acp --accept-hooks` | JSON-RPC 双向 | JSON-RPC (session/update) | 无 | ACP tool_call |

统一的 `streamFormat` 枚举：`claude-stream-json` / `json-event-stream` / `acp-json-rpc`，对应三个流解析器。

### 2.2 流式协议解析与 SSE 推送

Daemon 把三种引擎的 stdout 事件统一映射为内部事件：

- `status: initializing / running`
- `text_delta`（助手回复增量）
- `thinking_delta`（思考过程增量）
- `tool_use` / `tool_input_delta` / `tool_result`
- `usage`（token 计费）
- `error`

内部事件通过 SSE 推送到 Web 前端，前端只消费统一事件，不感知引擎差异。

### 2.3 会话持久化与上下文传递

- **Claude**：会话 ID 存 SQLite `agent_sessions` 表；首轮发完整 transcript，后续轮 `--resume` 仅发最新请求，靠 Claude 自身会话文件续上下文
- **Codex / Hermes**：无会话恢复，每轮全量 transcript 通过 stdin 发送
- 稳定指令块（系统 prompt + 工具契约）通过 hash 指纹判断是否变化，未变化时跳过重发

### 2.4 沙箱隔离

| 平台 | Codex 沙箱 | 说明 |
|------|-----------|------|
| macOS (Seatbelt) | `workspace-write` | 仅允许写工作区 |
| Linux (Landlock+seccomp) | `workspace-write` | 同上 |
| Windows / WSL | `danger-full-access` | 无可用沙箱，需用户显式同意 |

可由 `OD_CODEX_SANDBOX=danger-full-access` 强制覆盖。

### 2.6 工作流管道编排

步骤完全可自定义，仅内置一套**研发流程模板**作为默认值。每步骤在 `.workstep/steps.json` 中定义，包含：`key` / `label` / `color` / `prompt` / `inputs` / `outputs` / `dependsOn`（上游依赖列表，用于构建 DAG）。

**内置默认模板**（研发流程，支持并行分支）：

```
                  ┌─ 前端开发 (frontend) ─┐
需求 (req) → UI 设计 (ui) ─┤                      ├─ 测试 (test) → 上线 (deploy)
                  └─ 后端开发 (backend) ─┘
```

- UI 设计完成后，前端 + 后端**同时 spawn 两个 LLM 子进程**并发执行
- 测试阶段等待前端和后端**均完成**后自动启动（汇合点）

用户可在画布上增删改任意步骤、重排顺序，或从零定义全新管道（如"调研 → 写作 → 发布"、"数据清洗 → 建模 → 评估 → 报告"、"选题 → 大纲 → 初稿 → 审校 → 排版"）。

步骤间通过产物衔接（PRD → 设计稿 → 代码 → 测试报告），画布编辑器支持拖拽节点、连接 I/O 端口、条件路由。

#### 阶段间提示词拼接流程

```
阶段 N 执行完成
  │
  ▼
产物落盘
  .workstep/artifacts/<stepKey>/<cardId>/<filename>
  │
  ▼
阶段 N+1 启动，Daemon 拼接 prompt
  ┌──────────────────────────────────────────────────┐
  │ ① 稳定指令块                                      │
  │    系统 prompt + 工具契约                          │
  │    (hash 指纹未变 → 跳过重发)                      │
  ├──────────────────────────────────────────────────┤
  │ ② 历史 transcript                                 │
  │    Claude: 首轮完整发送，后续轮 --resume 跳过       │
  │    Codex/Hermes: 每轮全量重发                      │
  │    含前序阶段的对话 + 产物路径引用                   │
  ├──────────────────────────────────────────────────┤
  │ ③ 当前阶段 prompt (from steps.json)               │
  ├──────────────────────────────────────────────────┤
  │ ④ 最新请求（用户输入）                              │
  └──────────────────────────────────────────────────┘
  │
  ▼
spawn 子进程 → stdin 发送 → 流式输出 → SSE 推前端
```

#### 阶段提示词拼接示例：前端开发阶段

**场景**：UI 设计阶段已完成，产出 `ui-design.md` 和 `api-spec.json`，启动前端开发阶段。

**① 系统 Prompt（稳定指令块）**

```markdown
你是 WorkStep 工作流编排系统的执行节点。你的任务是完成当前阶段的开发工作，严格按照指定的输入输出格式执行。

## 工具契约
- 你可以读写文件、执行命令
- 所有产物必须写入指定路径：.workstep/artifacts/<stepKey>/<cardId>/
- 产物格式必须严格匹配 outputs 声明的 type

## 当前阶段
- key: frontend
- label: 前端开发
- engine: claude
```

**② 上游产物引用（从 inputs 字段自动生成）**

```markdown
## 输入产物（从上游阶段读取）

以下文件已就绪，可直接读取：

1. **UI 设计稿** (Figma → Markdown 导出)
   - 路径: `.workstep/artifacts/ui/<cardId>/ui-design.md`
   - 内容: 页面布局、组件结构、交互说明

2. **接口文档** (JSON)
   - 路径: `.workstep/artifacts/ui/<cardId>/api-spec.json`
   - 内容: RESTful API 定义、请求响应格式

3. **PRD 文档** (Markdown)
   - 路径: `.workstep/artifacts/req/<cardId>/prd.md`
   - 内容: 业务需求、用户场景、验收标准
```

**③ 阶段专属 Prompt（来自 steps.json）**

```markdown
## 任务要求

根据 UI 设计稿和接口文档，开发前端页面，实现状态管理和单元测试。

### 输入产物
- UI 设计稿 (Figma): 页面布局、组件层级、交互流程
- 接口文档 (JSON): API 端点、请求参数、响应格式
- 组件库 (React): 现有可复用组件

### 输出产物
- **前端页面** (React): 完整页面组件，使用 TypeScript
- **状态管理** (Zustand): 全局状态 store，含 API 调用逻辑
- **单元测试** (Vitest): 覆盖核心组件和状态逻辑

### 输出格式要求
1. `pages/` 目录存放页面组件
2. `stores/` 目录存放 Zustand store
3. `__tests__/` 目录存放测试文件
4. 每个文件顶部注释说明用途
5. 组件 props 类型定义完整
```

**④ 用户请求（可选）**

```markdown
## 用户补充说明
优先实现登录和注册页面，使用 Tailwind CSS。
```

**完整拼接后的 Prompt**

```
[系统 Prompt] + [上游产物引用] + [阶段专属 Prompt] + [用户请求]
```

---

#### 阶段完成后审查流程

每个阶段完成后，Daemon 自动启动**审查子进程**验证产物是否符合预期。

**审查 Prompt 模板**

```markdown
你是 WorkStep 的产物审查节点。你的任务是验证上一阶段的输出是否符合预期。

## 审查目标
- 阶段: frontend (前端开发)
- 卡片 ID: <cardId>

## 审查清单

### 1. 产物完整性
检查以下文件是否存在且非空：
- `.workstep/artifacts/frontend/<cardId>/pages/*.tsx`
- `.workstep/artifacts/frontend/<cardId>/stores/*.ts`
- `.workstep/artifacts/frontend/<cardId>/__tests__/*.test.ts`

### 2. 格式合规性
- React 组件是否使用 TypeScript？
- 是否包含 props 类型定义？
- Zustand store 是否导出 hooks？
- 测试文件是否使用 Vitest？

### 3. 需求匹配度
读取上游产物：
- `.workstep/artifacts/ui/<cardId>/ui-design.md`
- `.workstep/artifacts/ui/<cardId>/api-spec.json`

验证前端实现是否覆盖 UI 设计稿中的所有页面和交互，API 调用是否匹配接口文档。

## 输出格式

返回 JSON 格式的审查报告：

```json
{
  "passed": true | false,
  "score": 0-100,
  "issues": [
    {
      "severity": "error" | "warning",
      "category": "missing_file" | "format_error" | "requirement_gap",
      "description": "具体描述",
      "suggestion": "修复建议"
    }
  ],
  "summary": "整体评价"
}
```

如果 `passed: false`，卡片状态置为 `paused`，等待用户干预（重试或修改 prompt 后重跑）。
```

**审查结果处理**

| 审查结果 | 卡片状态 | 后续动作 |
|---------|---------|---------|
| `passed: true` | `running` | 自动进入下一阶段 |
| `passed: false` | `paused` | 详情页显示 issues 列表，用户可选择：① 重试当前阶段 ② 修改 prompt 重跑 ③ 强制继续 |

### 2.7 提示词与返回结果记录

每个 LLM 调用的提示词与返回结果在 **四个层级** 留痕，覆盖实时、持久、回溯、可观测四类用途：

| 层级 | 位置 | 内容 | 生命周期 |
|------|------|------|---------|
| 1 内存 Run 注册表 | `runs.ts` 的 `run.events[]` | 最多 2000 条事件，SSE 实时推送前端 | TTL 30 分钟后自动清理 |
| 2 磁盘 JSONL 日志 | `.od/runs/<runId>/events.jsonl` | 每事件一行 JSON（含 timestamp） | 永久保留，便于回溯 |
| 3 SQLite messages 表 | `db.ts` | `events_json` 存全部 agent 事件数组；`content` 拼接所有 `text_delta` 为完整回复 | 永久保留，支持历史回放 |
| 4 Langfuse 外部追踪 | `langfuse-bridge.ts`（可选） | run 完成后一次性上报：prompt / model / token 用量 / 事件摘要 / metadata | 仅在配置 Langfuse endpoint 时启用 |

**关键写入流程**（每个 agent stdout 事件都经过的同一条管道）：

```
agent stdout 事件
  → 流解析器转换为内部事件（text_delta / tool_use / ...）
    → runs.emit()
      ├─ run.events.push(record)         // 内存层
      ├─ events.jsonl 追加一行            // 磁盘层
      ├─ SSE 推送给前端                   // 实时层
      └─ persistRunEventToAssistantMessage()
          └─ UPDATE messages SET
              content = content || delta,
              events_json = [...events, event]
```

**内部事件 → SQLite 持久化 kind 映射**：

| 内部事件 | 持久化 kind | 存储内容 |
|---------|-----------|---------|
| `text_delta` | `text` | `{ kind: 'text', text: delta }` |
| `thinking_delta` | `thinking` | `{ kind: 'thinking', text: delta }` |
| `tool_use` | `tool_use` | `{ kind: 'tool_use', id, name, input }` |
| `tool_result` | `tool_result` | `{ kind: 'tool_result', toolUseId, content, isError }` |
| `usage` | `usage` | `{ kind: 'usage', inputTokens, outputTokens, costUsd, durationMs }` |
| `status` | `status` | `{ kind: 'status', label, detail }` |
| `tool_input_delta` | 不持久化 | 仅实时显示用 |

**Prompt 拆分记录**：完整 prompt 不直接存入 messages 表。各部分（`daemonSystemPrompt` / `runtimeToolPrompt` / `skillPrompt` / `designSystemPrompt` / `userRequest`…）通过 `run.promptTelemetry` 在内存中拆分记录，仅用于 Langfuse 上报时引用；`run.userPrompt` 字段单独保存用户原始输入文本。

---

## 3. 功能需求

### 3.1 工作流编排（F1）

**目标**：用户能可视化定义、修改、保存一条管道。可以是内置研发流程模板的微调，也可以是从零搭建的任意自定义流程（写作 / 数据 / 运营…）。

| 功能项 | 说明 | 优先级 |
|--------|------|--------|
| F1.1 阶段画布 | Dify 风格节点画布，拖拽创建 / 移动阶段节点 | P0 |
| F1.2 I/O 端口 | 每个节点显示输入产物（PRD / 设计稿 / 代码…）与输出产物 | P0 |
| F1.3 连接步骤 | 节点间连线表示产物流转；线可点击选中、拖拽端点重连 | P0 |
| F1.4 条件路由 | 输出端口可挂条件（如"需求不清晰 → 回到需求"，否则 → UI） | P1 |
| F1.5 并行分支 | 节点可 fan-out 到多个下游节点并发执行，汇合点等待所有分支完成后继续 | P0 |
| F1.6 阶段编辑器 | 独立页面编辑单个阶段的 prompt / inputs / outputs / 引擎选择 | P0 |
| F1.7 管道保存 | 导出为 `.workstep/steps.json`，下次打开恢复 | P0 |
| F1.8 模板选择 | 新建管道时可选择内置研发模板，或从空白画布开始 | P1 |

**交互原则**（用户级约束）：编排一条新管道的核心操作不超过 3 步——① 拖入阶段节点，② 连线，③ 保存。

### 3.2 卡片管理（F2）

**目标**：每个研发任务是一张卡片，卡片按阶段泳道排列。

| 功能项 | 说明 | 优先级 |
|--------|------|--------|
| F2.1 卡片列表 | Codex 风格左侧栏：项目分组 + 卡片列表 + 底部"+ 新建" | P0 |
| F2.2 卡片详情 | 点击编辑按钮跳转 `card-detail.html?id=<cardId>`，展示阶段产物 / 会话 / 状态 | P0 |
| F2.3 状态机 | 卡片状态：`ready` / `running` / `paused` / `stopped`，色编码（蓝 / 绿 / 黄 / 红） | P0 |
| F2.4 卡片操作 | 开始 / 暂停 / 停止 / 删除 / 编辑 / 复制 | P0 |
| F2.5 阶段进度 | 卡片内显示当前所处阶段（需求 / UI / …），顶部展示当前阶段名 | P0 |

### 3.3 LLM 引擎调用（F3）

**目标**：用户为每阶段选引擎，卡片启动后按管道顺序调用。

| 功能项 | 说明 | 优先级 |
|--------|------|--------|
| F3.1 引擎选择 | 阶段编辑器内下拉选 Claude / Codex / Hermes | P0 |
| F3.2 模型覆盖 | 可选填 `--model`（如 `gpt-5.5` / `grok-4.3`） | P1 |
| F3.3 工作目录 | 卡片绑定一个本地目录作为 `--add-dir` / `-C` 传入 | P0 |
| F3.4 流式展示 | 助手文本 / 思考 / 工具调用 / 工具结果通过 SSE 实时推送到详情页 | P0 |
| F3.5 中途干预 | Claude 的 `AskUserQuestion`、Hermes 的权限请求，前端能弹窗收集用户选择并回灌 stdin | P1 |
| F3.6 失败重试 | 单阶段失败可手动重试，不影响已完成阶段 | P1 |

**交互原则**：从卡片创建到首条 LLM 输出，操作不超过 3 步——① 新建卡片，② 选目录，③ 启动。

### 3.4 产物管理（F4）

**目标**：每阶段的输出产物落盘可追溯，下一阶段自动读取。

| 功能项 | 说明 | 优先级 |
|--------|------|--------|
| F4.1 产物文件 | 按阶段 `key` 分目录存放（如 `.workstep/artifacts/req/prd.md`） | P0 |
| F4.2 产物预览 | 详情页内嵌 Markdown / 图片 / 代码预览 | P1 |
| F4.3 产物衔接 | 下一阶段启动时，自动把上一阶段产物路径加入 prompt 上下文 | P0 |
| F4.4 产物版本 | 每次重跑生成新版本，可对比 | P2 |

### 3.5 会话与历史（F5）

| 功能项 | 说明 | 优先级 |
|--------|------|--------|
| F5.1 会话列表 | 左侧栏按项目分组显示历史会话 | P0 |
| F5.2 会话恢复 | Claude 卡片支持"继续上次"（`--resume`） | P0 |
| F5.3 全量回放 | 任意历史会话可回放当时的思考 / 工具 / 产物 | P1 |
| F5.4 搜索 | 按卡片名 / 阶段 / 时间筛选 | P1 |

---

## 4. 系统架构

```
┌─────────────────────────────────────────────────────┐
│  Web 前端 (apps/web)                                  │
│  - 画布编辑器 / 卡片列表 / 详情页                       │
│  - SSE 消费统一内部事件                                │
└──────────────────────┬──────────────────────────────┘
                       │ fetch /api/runs + EventSource
┌──────────────────────▼──────────────────────────────┐
│  Daemon (apps/daemon)                                 │
│  - POST /api/runs: 拼接 prompt, spawn 子进程           │
│  - runtimes/defs/: claude.ts / codex.ts / hermes.ts   │
│  - 流解析器: claude-stream / json-event-stream / acp   │
│  - SQLite: agent_sessions, artifacts                  │
└──────────────────────┬──────────────────────────────┘
                       │ spawn + stdin/stdout 管道
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   claude -p       codex exec     hermes acp
   (JSONL 流)      (纯文本)       (JSON-RPC)
```

### 4.1 关键文件落点

| 路径 | 职责 |
|------|------|
| `apps/daemon/src/server.ts` | HTTP / SSE 入口 |
| `apps/daemon/src/runs.ts` | 内存 Run 注册表（events[] + emit 三路写入） |
| `apps/daemon/src/db.ts` | SQLite，含 `messages` / `agent_sessions` 表 |
| `apps/daemon/src/runtimes/defs/*.ts` | 引擎定义 |
| `apps/daemon/src/claude-stream.ts` | Claude JSONL 解析 |
| `apps/daemon/src/json-event-stream.ts` | Codex JSONL 解析 |
| `apps/daemon/src/acp.ts` | Hermes JSON-RPC 解析 |
| `apps/daemon/src/langfuse-bridge.ts` | 可选 Langfuse 上报 |
| `.od/runs/<runId>/events.jsonl` | 单 run 事件流日志（每事件一行，永久） |
| `.workstep/steps.json` | 工作流定义 |
| `.workstep/artifacts/<stepKey>/<cardId>/` | 产物落盘 |

---

## 5. 数据模型

### 5.1 卡片 (Card)

```ts
interface Card {
  id: number;
  title: string;
  desc: string;
  cwd: string;              // 工作目录
  pipelineId: string;       // 关联的 .workstep/steps.json 版本
  currentSteps: string[];   // 当前激活的阶段 key 列表（支持并行分支）
  status: 'ready' | 'running' | 'paused' | 'stopped';
  engine: 'claude' | 'codex' | 'hermes';
  model?: string;
  sessionId?: string;       // Claude 的 resume 会话 ID
  createdAt: number;
  updatedAt: number;
}
```

### 5.2 阶段 (Step)

来自 `.workstep/steps.json`，结构见 §2.6。

### 5.3 会话 (agent_sessions)

SQLite 表：

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `card_id` | 关联卡片 |
| `engine` | 引擎名 |
| `session_id` | Claude 的 `--session-id` |
| `instruction_hash` | 稳定指令块 hash，判断是否跳过重发 |
| `created_at` / `last_active_at` | 时间戳 |

### 5.4 消息 (messages)

每次 LLM 调用的完整事件流落库到 SQLite `messages` 表，是回溯与重放的事实源：

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,    -- 对话（卡片 run 链）
  role TEXT NOT NULL,                -- 'user' / 'assistant'
  content TEXT NOT NULL,            -- user 原始输入 / assistant 全部 text_delta 拼接
  agent_id TEXT,                    -- 'claude' / 'codex' / 'hermes'
  agent_name TEXT,                  -- 展示用名称（如 'Claude Code'）
  run_id TEXT,                       -- 关联的 run UUID（→ events.jsonl）
  run_status TEXT,                   -- 'succeeded' / 'failed'
  events_json TEXT,                  -- 所有 agent 事件数组（见 §2.7 映射）
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

**写入时机**：创建消息时初始化 `content`（user 原文 / assistant 空）；run 期间每个 `text_delta` 实时 append 到 `content`，每个 agent 事件实时 append 到 `events_json`；run 结束时回填 `run_status` / `ended_at`。

**查询示例**（读取卡片对话的完整事件流用于回放）：

```sql
SELECT role, content, events_json, agent_id, run_status
FROM messages
WHERE conversation_id = ?
ORDER BY position;
```

### 5.5 产物 (Artifact)

文件系统布局：

```
.workstep/
  steps.json                      # 管道编排定义
  artifacts/
    req/
      <cardId>/
        prd.md            # v1
        prd.v2.md         # 重跑后的新版本
    ui/
      <cardId>/
        design-spec.md
    frontend/
      <cardId>/
        src/...
```

---

## 6. 交互流程

### 6.1 创建卡片并启动（核心流程，3 步）

1. 左侧栏点"+ 新建" → 输入标题、选工作目录、选管道模板
2. 卡片进入"需求"阶段，点"启动"
3. Daemon spawn Claude → 流式推送 PRD 草稿到详情页

### 6.2 阶段流转

- 当前阶段产物落盘后，Daemon 检查出向连接线，找出所有下游节点
- **分叉（fan-out）**：若下游有多个节点，**同时 spawn 多个 LLM 子进程**并发执行
- **汇合（join）**：下游节点若有多个 `inputs`，必须等所有上游产物**全部落盘就绪**后才启动；任一上游未完成则该节点保持阻塞
- 条件路由：根据产物内容（如 PRD 里是否标注"需求不清晰"）走不同分支
- 下一阶段自动启动或等待用户确认（管道配置项）

### 6.3 中途干预

- Claude 触发 `AskUserQuestion` → SSE 推 `tool_use` → 前端弹选择框 → 用户选 → POST `/api/runs/{id}/tool_result` → Daemon 注入 stdin
- Hermes 触发 `session/request_permission` → Daemon 自动回 `approve_for_session`（v1 不阻塞）

### 6.4 失败与重试

- 阶段失败 → 卡片状态置 `stopped` → 详情页显示错误堆栈
- 用户修改 prompt 或产物后点"从当前阶段重试" → 重新 spawn，`sessionId` 复用（Claude）或全量 transcript（Codex / Hermes）

---

## 7. 非功能需求

### 7.1 安全

- **沙箱**：Codex 默认 `workspace-write`，覆盖需显式 env
- **凭证**：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 在 daemon 侧剥离（除非设了 `ANTHROPIC_BASE_URL`），强制走 `claude login` 自身认证
- **路径**：`--add-dir` / `-C` 限定在用户选定的工作目录树内，禁止 `..` 逃逸

### 7.2 性能

- SSE 首字节 < 500ms（Daemon spawn 到第一条 `text_delta`）
- 同卡片内：无依赖关系的阶段可并发执行（如前端 + 后端同时 spawn）；不同卡片可并行
- 会话历史查询 < 100ms（SQLite 索引 `card_id` + `last_active_at`）

### 7.3 可扩展

- 新增 LLM 引擎 = 新增 `runtimes/defs/<name>.ts` + 对应流解析器 + `streamFormat` 枚举值
- 新增阶段类型 = `.workstep/steps.json` 加一条，无需改代码
- 产物类型由 `outputs[].type` 声明，前端按 type 选预览器

### 7.4 可观测

四层记录架构（详见 §2.7）天然满足以下观测需求：

- **token 与成本**：每次引擎调用落 `usage` 事件（输入 / 输出 token + `costUsd` + `durationMs`），存入 `messages.events_json`
- **实时**：内存 `run.events[]` ≤ 2000 条经 SSE 推前端；TTL 30 分钟后自动清理
- **回溯**：`.od/runs/<runId>/events.jsonl` 每事件一行永久保留，可被外部工具 `tail` 查看
- **历史回放**：SQLite `messages` 表 `events_json` 数组支持任意历史会话的思考 / 工具 / 产物全量重放
- **外部追踪**：配置 Langfuse endpoint 后，run 完成时上报 prompt / model / token / 事件摘要（可选）
- **Daemon 切分**：Daemon 日志按 `card_id` + `step` 切分，便于按卡片排查
- **前端调试**：详情页可"查看原始 JSONL"——直接拉取 `events.jsonl` 渲染调试视图

---

## 8. 验收标准

### 8.1 编排

- [ ] 拖拽默认阶段节点能连成 DAG 管道（含并行分支），保存为 `.workstep/steps.json`
- [ ] 重新打开应用，画布能从 `.workstep/steps.json` 恢复节点位置与连线
- [ ] UI 设计完成后，前端 + 后端两个阶段同时 spawn 并发执行
- [ ] 测试阶段在前端产物和后端产物**均落盘**后才自动启动；任一未完成时保持阻塞
- [ ] 条件路由：PRD 含"需求不清晰"标记时，连线回到需求阶段而非进入 UI

### 8.2 引擎调用

- [ ] 选 Claude 引擎启动卡片，详情页能在 500ms 内看到第一条 `text_delta`
- [ ] 选 Codex 引擎，能在 Windows 上以 `danger-full-access` 跑通（用户显式同意后）
- [ ] 选 Hermes 引擎，权限请求被自动批准，不阻塞流程
- [ ] Claude 卡片关闭后重开，能通过 `--resume` 继续上次会话

### 8.3 产物

- [ ] 需求阶段产物 `.workstep/artifacts/req/<cardId>/prd.md` 落盘
- [ ] UI 阶段启动时，prompt 上下文自动包含上阶段 PRD 路径
- [ ] 详情页能预览 Markdown 产物

### 8.4 安全

- [ ] Codex 沙箱在 macOS 默认 `workspace-write`，写工作区外路径失败

### 8.5 交互

- [ ] 新建卡片到首条 LLM 输出 ≤ 3 步操作
- [ ] 编辑管道到保存 ≤ 3 步操作

---

## 9. 里程碑

| 里程碑 | 范围 | 预计 |
|--------|------|------|
| M1 · 引擎打通 | Daemon + 三引擎 spawn + SSE + 卡片列表 + 详情页 | 2 周 |
| M2 · 管道编排 | 画布编辑器 + .workstep/steps.json + 阶段流转 + 产物衔接 | 2 周 |
| M3 · 干预与回溯 | AskUserQuestion 回灌 + 会话恢复 + 产物版本 | 1 周 |
| M4 · 安全加固 | 沙箱 + 凭证剥离 | 3 天 |

---

## 10. 附：未决问题

- 卡片跨阶段共享上下文时，Codex / Hermes 全量 transcript 的 token 成本如何控制？是否需要摘要压缩？
- 产物衔接的格式约定（PRD → UI 阶段读什么字段？）是否需要一套约定 schema？
- 多人场景下 `.workstep/steps.json` 如何版本化与合并？（v1 单机，搁置）
