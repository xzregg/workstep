# WorkStep implementation records

本目录保存已经落地的设计记录和明确标注的未来提案。它们用于解释决策背景，不替代当前代码、测试与 `docs/` 中的现行契约。

## 已实现

- [阶段审核与自动重跑](08-stage-review-and-auto-retry.md)
- [阶段级引擎配置覆盖](09-stage-engine-config-overrides.md)
- [ACP / AG-UI 事件统一](10-agui-event-unification.md)
- [引擎基类拆分](11-engine-base-classes.md)
- [产物轮次目录](artifacts-rounds.md)
- [会话聊天模式](chat-session.md)
- [并发限制与项目配置](concurrency-limit.md)
- [Git 管理功能](git-management-implementation.md)
- [Git 管理面板原型](git-panel-prototypes.md)
- [移动端适配](mobile-adaptation.md)
- [新手引导](onboarding.md)
- [定时任务助手](schedule-agent.md)
- [会话分叉与跨引擎交接](session-forking.md)
- [任务协调 Agent](task-coordinator-agent.md)

## 提案

- [平台模式](platform-mode.md) — 尚未实现，不属于当前产品能力。

每份记录开头必须声明状态。行为发生变化时，优先更新 `docs/` 的现行说明，并在对应记录中注明历史内容不再是当前契约。
