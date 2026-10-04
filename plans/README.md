# WorkStep 未完成方案与验收

本目录保留尚未完成的功能方案、持续演进的行为边界和待完成验收。已实现功能的现行说明归入 [docs/](../docs/README.md)，职责与测试入口以 [Code Map](../docs/code-map.md) 为准；已完成且被现行文档替代的实施记录不继续保留。

## 平台模式

- [平台模式总方案](platform-mode.md) — 实施中，已有账号、设备授权、远程项目与分享能力，不能视为整体验收完成。
- [逐阶段开发计划](platform-gateway-development.md) — 正式阶段交付与验收边界。
- [剩余开发与验收](platform-gateway-remaining-development.md) — 批次 8/9 的页面、实际桌面联调、容量与恢复等剩余事项。

总方案仍引用 [Gateway 门户原型](gateway-prototype.html) 和 [平台架构图](platform-gateway-architecture.html)，两者保留作为设计辅助，不代表当前功能已全部实现。

## 功能方案与待验收边界

- [Git 合并预览与三栏冲突解决](git-merge-conflict-resolution.md) — 尚未实现；现有 Git 行为见 [开发指南](../docs/development.md#git-管理的现行边界)。
- [移动端适配与验收](mobile-adaptation.md) — 已实现的适配及仍待完成的 Safari/Chrome 真机检查；现行尺寸规范见 [前端设计](../docs/frontend-design.md)。
- [助手提示词传输与查看](assistant-prompt-transport.md) — 已接入各入口，保留适配器恢复、指令更新及输入持久化边界。
- [会话分叉与跨引擎交接](session-forking.md) — 首版已实现，保留交接约束和任意历史消息分叉的后续范围。

## 已实现功能的文档入口

- [架构](../docs/architecture.md)：项目数据、并发、普通会话、定时助手与脚本 Action。
- [工作流执行](../docs/workflow-engine-execution.md)：步骤、产物轮次、审核、协调提案、重跑和恢复。
- [引擎开发](../docs/llm-engine-development-guide.md)：基类、配置覆盖及 ACP/AG-UI 事件契约。
- [开发指南](../docs/development.md)：模块边界、Git 管理、新手引导与验证。
- [渠道机器人](../docs/channel-bots.md)：默认项目、群绑定、收发、配置与真实租户验收边界。

后续方案必须标明状态；行为落地后同步现行文档及测试，再移除已经被替代的计划。历史决策和实施过程可通过 Git 历史查看。
