# WorkStep 实施方案索引

`plans/` 保存功能设计、实施记录和未来提案，不是当前架构的权威来源。当前行为以已验证代码、根目录 `AGENTS.md` 和 `docs/` 为准。

| 文档 | 状态 | 用途 |
|---|---|---|
| `08-stage-review-and-auto-retry.md` | 已实现／历史方案 | 审核与自动重跑的设计背景；接口和事件以代码为准 |
| `09-stage-engine-config-overrides.md` | 已实现 | 阶段级引擎配置覆盖实施记录 |
| `10-agui-event-unification.md` | 已实现 | ACP 内部事件与 AG-UI 对外事件迁移记录 |
| `11-engine-base-classes.md` | 已实现 | 引擎基类拆分记录 |
| `artifacts-rounds.md` | 已实现 | 产物轮次和 manifest 方案记录 |
| `chat-session.md` | 已实现／历史方案 | 会话聊天初版记录；当前接口与字段已继续演进 |
| `concurrency-limit.md` | 已实现 | 任务／对话双通道并发限制记录 |
| `mobile-adaptation.md` | 已实现／待真机验收 | 移动端适配验收基线 |
| `onboarding.md` | 已实现 | 新手引导行为说明 |
| `schedule-agent.md` | 已实现 | 定时任务调用任务创建助手的设计记录 |
| `session-forking.md` | 第一版已实现 | 会话分叉与跨引擎交接；任意消息分叉未实现 |
| `task-coordinator-agent.md` | 核心链路已实现 | 协调助手、动作提案、阶段消息和重跑设计记录 |
| `platform-mode.md` | 提案／未实现 | 登录、平台数据库、用户和权限管理的未来方案 |

`workstep-commercial-plan.html` 是独立商业规划展示，不代表当前产品能力，也不纳入本轮 Markdown 文档收口。

已删除的 `00`–`07` 早期计划描述了旧 API、SSE、旧事件词汇、旧数据模型和早期前端选型，已被当前代码与 `docs/` 完全取代。
