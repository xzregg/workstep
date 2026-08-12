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

### 前端 ✅ 已完成

- [x] `useWebSocket` hook（指数退避重连）
- [x] Zustand store（projectStore, taskStore）
- [x] 项目列表 + 初始化项目
- [x] 任务列表 + 创建任务
- [x] 任务详情（实时流渲染 text_delta / tool_use / usage）
- [x] Vite proxy 配置（dev 代理 `/api` 和 `/ws`）
- [x] React Router 路由（/ → 项目, /tasks → 列表, /tasks/:id → 详情）
- [x] TypeScript + Vite 构建通过

### 端到端验证 ✅ 已完成

- [x] 集成测试：init project → create task → run → WebSocket 事件广播
- [x] 多订阅者接收相同事件
- [x] events_json 持久化到 message 表
- [x] TypeScript + Vite 构建通过

---

## P2：多引擎 ✅ 已完成（64 tests）

- [x] `CodexEngine`: 直接 CLI（codex exec --json + sandbox 策略）
- [x] `HermesEngine`: JSON-RPC 双向通信 + 权限自动批准
- [x] `AcpEngineBase`: Python ACP SDK 基类
- [x] `ClaudeCodeAcpEngine`: ACP 模式
- [x] `CodexAcpEngine`: ACP 模式
- [x] `QoderAcpEngine`: ACP 模式（qodercli --acp）
- [x] Registry 自动选择策略（ACP 优先，fallback CLI）
- [x] `agent-client-protocol>=0.11.0` 依赖

---

## P3：管道编排 ✅ 已完成（79 tests）

- [x] `DAGScheduler`: dependsOn 解析 + cycle 检测 + topological_order
- [x] 并行分支: fan-out（asyncio.gather）+ join
- [x] Prompt 拼接: 系统指令 + 上游 artifact + 阶段 prompt + 用户输入
- [x] `TaskRunner`: 多阶段执行 + per-step 引擎选择 + 事件广播
- [x] Artifact 目录自动创建

---

## P4：干预与回溯 ✅ 已完成（88 tests）

- [x] `InterventionManager`: request/deliver/cancel + 超时
- [x] 历史回放: get_task_history + get_step_history + replay_events
- [x] WebSocket 'respond' 消息路由到 InterventionManager
- [x] API: /api/task/{id}/history, /api/intervention/respond

---

## P5：扩展

- [ ] QCodeEngine / OpenClawEngine
- [x] APIEngine 移除：API 直调不再作为独立引擎，凭据改为「供应商」统一管理（见设置 → 供应商）
- [ ] 工作流模板市场
- [ ] F1.4 条件路由
- [ ] F2.4 卡片操作（暂停/删除/复制）
- [ ] F4.2 产物预览（Markdown/代码/图片）
- [ ] F5.1 会话列表（sidebar 显示历史会话）
- [ ] F5.4 搜索（按任务名/阶段/时间筛选）

## 开发原则

1. **TDD**: 每个模块先写测试
2. **引擎独立**: parser 独立测试，不依赖 Daemon
3. **项目隔离**: 数据在项目 DB 内闭环
4. **服务层统一**: API 和 CLI 都是薄壳，逻辑在 services/
