# 分阶段构建计划

> 最后更新：2026-07-13

## 技术决策（Grilling 确认）

| 议题 | 决策 |
|------|------|
| 后端语言 | Python + FastAPI |
| 前端 | React + React Flow + Volta (node@20, yarn@1) |
| 状态管理 | Zustand |
| 实时通信 | **WebSocket**（双向，中途干预无需额外 HTTP）+ 前端断线重连 |
| 引擎层 | 双模式：直接 CLI + ACP，BaseLLMEngine 接口不变 |
| ACP SDK | `pip install agent-client-protocol`（Python，仅依赖 pydantic） |
| 项目配置 | `~/.workstep/config.json` 统一 ConfigStore |
| 项目列表 | `[{name, path, ...}]` 数组对象，可扩展属性 |
| Schema 命名 | Pydantic 用 `BaseSchema`，Peewee 用 `BaseModel` |
| 目录结构 | `apps/daemon/` + `apps/web/` monorepo |
| 端口 | 固定 8765，FastAPI 统一 serve 前端 + WS + REST |
| P1 切片 | 单任务、单阶段、Claude 引擎端到端跑通 |

## 项目结构

```
workstep/
├── apps/
│   ├── daemon/                    # Python + FastAPI
│   │   ├── main.py                # FastAPI 入口 + WebSocket + 静态文件
│   │   ├── settings.py            # pydantic-settings
│   │   ├── api/                   # 路由层（project, task）
│   │   ├── schemas/               # BaseSchema + 请求/响应模型
│   │   ├── models/                # Peewee ORM（Task, TaskStep, Message）
│   │   ├── services/              # 业务逻辑（project, task, config）
│   │   ├── engines/               # BaseLLMEngine + ClaudeCodeEngine
│   │   ├── streaming/bus.py       # EventBus → WebSocket 广播
│   │   └── tests/                 # 38 tests passing
│   │
│   └── web/                       # React + Vite + React Flow
│       └── src/
│
├── docs/                          # 产品文档（PRD、引擎协议）
├── plans/                         # 技术架构文档
└── ui/                            # HTML 原型（参考用）
```

---

## P1：单引擎端到端

**目标**：创建任务 → Claude 引擎执行 → WebSocket 实时推送 → 前端显示

### 后端 ✅ 已完成（38 tests）

- [x] FastAPI 骨架 + WebSocket 双向通信 + 静态文件服务
- [x] Peewee 数据模型（Task, TaskStep, Message）
- [x] 项目服务（init/register/rename + ConfigStore 持久化）
- [x] 引擎层（BaseLLMEngine 抽象 + ClaudeCodeEngine 直接 CLI 模式）
- [x] 任务服务（create/list/run/cancel + EventBus 广播）
- [x] 引擎注册表（is_installed + create_engine）
- [x] 全局配置 ConfigStore（`~/.workstep/config.json`）

### 前端 ⬜ 未开始

- [ ] `useWebSocket` hook（连接 `ws://host/ws` + 指数退避重连）
- [ ] Zustand store（tasks, activeTask, messages）
- [ ] 项目列表 + 初始化项目
- [ ] 任务列表 + 创建任务
- [ ] 任务详情（实时流渲染 text_delta / tool_use / usage）
- [ ] Vite proxy 配置（dev 代理 `/api` 和 `/ws`）

### 端到端验证 ⬜

- [ ] 前端 → POST /api/task/run → Claude spawn → WebSocket 实时渲染
- [ ] 断线重连后恢复状态

---

## P2：多引擎

**目标**：支持 Claude / Codex / Hermes 引擎切换，引入 ACP 模式。

- [ ] `codex.py`: CodexEngine（直接 CLI）
- [ ] `codex_acp.py`: Codex ACP 模式
- [ ] `hermes.py`: HermesEngine（JSON-RPC）
- [ ] `claude_code_acp.py`: Claude ACP 模式（Python ACP SDK）
- [ ] `qoder_acp.py`: Qoder ACP 模式
- [ ] Registry 自动选择策略（优先 ACP，fallback 原生 CLI）
- [ ] 会话恢复：Claude `--resume` / ACP `_meta.claudeCode.options.resume`
- [ ] 前端引擎选择 UI

**验收**：
- [ ] 同一任务，切换不同引擎，都能跑通
- [ ] 无 Node.js 时自动 fallback 到直接 CLI
- [ ] Claude 任务停止后重启能 resume 继续

---

## P3：管道编排

**目标**：画布编辑器 + DAG 调度 + 并行分支。

- [ ] DAGScheduler: dependsOn 解析 + ready_steps 计算
- [ ] 并行分支: fan-out (asyncio.gather) + join
- [ ] 画布编辑器: React Flow 拖拽节点 + 连线 + 保存 steps.json
- [ ] 阶段审查: 完成后自动验证产物
- [ ] Prompt 拼接: 上游 artifact 自动注入

**验收**：
- [ ] UI 设计完成后，前端 + 后端同时并发执行
- [ ] 测试阶段在前端和后端均完成后才启动
- [ ] 画布上拖拽修改管道，保存后下次打开恢复

---

## P4：干预与回溯

**目标**：中途干预 + 历史回放 + 产物版本。

- [ ] 中途干预: AskUserQuestion → WebSocket → 注入 stdin
- [ ] 历史回放: 从 events_json 重放
- [ ] 产物版本: 每次重跑生成新版本
- [ ] 搜索: 按任务名 / 阶段 / 时间筛选

**验收**：
- [ ] Claude 触发提问时前端弹窗，回答后引擎继续
- [ ] 任意历史任务可回放完整执行过程

---

## P5：扩展

- [ ] QCodeEngine / OpenClawEngine
- [ ] APIEngine: 直接调 OpenAI / Anthropic API
- [ ] 工作流模板市场

## 开发原则

1. **TDD**: 每个模块先写测试
2. **引擎独立**: parser 独立测试，不依赖 Daemon
3. **项目隔离**: 数据在项目 DB 内闭环
4. **服务层统一**: API 和 CLI 都是薄壳，逻辑在 services/
