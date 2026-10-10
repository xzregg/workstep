# WorkStep documentation

- [项目概览](overview.md) *(简体中文)* — 定位、子应用架构、核心概念、快速开始与文档导航，新开发者的入口。
- [Architecture](architecture.md) *(简体中文)* — components, storage, engine boundary, and event flow.
- [Multi-engine architecture](multi-engine-architecture.md) *(简体中文)* — engine base classes, auto-discovery, ACP/AG-UI event boundary, capability declarations, and the engine list.
- [Workflow engine execution](workflow-engine-execution.md) *(简体中文)* — task creation, DAG scheduling, stage prompts, reviews, artifact routing, reruns, coordinator actions, and recovery.
- [Engine runtime management](engine-runtime-management.md) *(简体中文)* — version selection, measured package downloads, and rollback.
- [桌面沙箱模式](desktop-sandbox.md) *(简体中文)* — Podman 下载、独立 Home、项目挂载、配置导入、模式切换与清理。
- [容器 Home 与运行时持久化](container-runtime.md) *(简体中文)* — 整体 Home 挂载、基础运行时初始化、引擎持久化与旧挂载迁移。
- [Development](development.md) — setup, test commands, module boundaries, Git management, onboarding, and pull-request checks.
- [Code map](code-map.md) *(简体中文)* — find feature owners, API and service boundaries, tests, and change workflow.
- [Gateway 开发与部署](gateway-development.md) *(简体中文)* — Gateway 分层、账号、授权、接口及部署入口；未完成验收仍以平台计划为准。
- [Gateway 运维](gateway-operations.md) *(简体中文)* — 域名、TLS、备份恢复和客户端发布。
- [企业微信与钉钉渠道机器人](channel-bots.md) *(简体中文)* — 平台凭证、长连接配置、任务群绑定与路由限制。
- [Project skill center](skill-center.md) — discovery, project selection, mirroring, API, and engine isolation.
- [GitHub settings](github-settings.md) — repository features, rulesets, security, Pages, and analytics.
- [Release checklist](releasing.md) — unsigned desktop packaging, SBOM, checksums, approval, and clean-machine validation.
- [Plan index](../plans/README.md) — remaining proposals, evolving behavior boundaries, and pending acceptance.
- [Product requirements](../PRODUCT.md) *(简体中文)* and [design system](../DESIGN.md) — product and visual decisions.

Repository-agent instructions remain in [`AGENTS.md`](../AGENTS.md); they point back to these human-facing documents instead of duplicating them.

- [渠道消息协议与接入开发](channel-message-protocol.md)：统一适配器、能力声明和图片/文件收发。

- [用户操作手册维护](../apps/landing/README.md#用户操作手册) — 官网功能指引、SDK 入门、截图与发布前同步要求。
- [固定手册演示环境](manual-demo.md) — 独立配置、模拟项目与 `8777` 端口的启动和复用。

- [项目数据存储位置与迁移](project-storage.md)

- [流程钩子：统一地址、设备身份和网关转发](workflow-hooks.md)

- [通知钩子](notification-hooks.md)：流程事件、平台投递、预览与重试。
