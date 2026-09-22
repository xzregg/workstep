# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

WorkStep 面向在本机组织研发工作的个人开发者与小型协作团队。项目所有者在自己的设备上运行 WorkStep，并可把项目授权给另一台安装了 WorkStep 的设备共同访问。

## Product Purpose

WorkStep 是本地优先的工作流编排工具，将多个 LLM 引擎串联成可定制的研发流程。成功意味着用户能在本地掌控项目数据与执行环境，同时按需把指定项目安全地开放给远端协作者。

## Positioning

项目数据和执行能力保留在项目所有者的 WorkStep 主机上；远端 WorkStep 通过受控连接操作项目，而不是把项目复制到中心化云端。多个 LLM 引擎共享统一的会话、事件与工作流模型。

## Operating Context

- 项目所有者通过内部网络、VPN，或自行配置的 HTTPS 域名提供远程访问。
- 接收者在另一台 WorkStep 中导入一次性分享字符串，把远程项目加入本地项目列表。
- 远程协作覆盖项目内的任务、工作流、会话与实时状态；全局系统接口不向远端开放。
- 项目所有者在系统设置中查看和管理已经授权的远端设备。

## Capabilities and Constraints

- 远程项目授权按设备管理；同一使用者的不同设备是不同授权。
- 新设备通过 24 小时内有效、只能兑换一次的邀请完成首次认证。
- 邀请兑换后签发设备凭证，默认授权期限为永久；所有者可选择有限期限。
- 项目所有者必须能看到已连接设备、在线状态和最近活动，并能随时撤销访问。
- 撤销或到期必须阻止新的项目请求和实时事件；远端本地项目入口可以保留并显示失效原因。
- WorkStep 不内置公网中继；外部访问依赖用户配置 HTTPS/WSS、反向代理和网络入口。
- 当前项目使用 React、TypeScript、Vite 前端和 FastAPI、Peewee、SQLite 后端。

## Brand Commitments

产品名称为 WorkStep。产品用语应直接、克制，并准确区分“邀请”“设备授权”“关闭远程访问”和“撤销访问”。

## Evidence on Hand

- 产品需求与架构资料位于 `docs/` 和 `plans/`。
- 可运行前端位于 `apps/web/`，可运行后台位于 `apps/daemon/`。
- 远程项目现有实现位于 `apps/daemon/services/remote_project.py`、`apps/daemon/api/remote_project.py`、`apps/web/src/components/ProjectShareDialog.tsx` 和 `apps/web/src/pages/RemoteProjectSettings.tsx`。
- 尚无需要在产品界面中引用的公开客户案例或外部安全认证材料，不应虚构。

## Product Principles

- 本地数据所有权优先，远程访问必须由项目所有者明确授权。
- 安全状态必须可见、可解释、可随时收回。
- 分享邀请与长期设备授权是两个不同阶段，界面和文案不能混淆。
- 默认操作保持简单，同时为需要更严格控制的用户提供期限和撤权能力。
- 远端失去权限后保留可理解的状态，不伪装成项目丢失或普通网络故障。
