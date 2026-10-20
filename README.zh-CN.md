<div align="center">

<img src="apps/web/src/assets/hero.svg" width="96" alt="WorkStep 品牌标志">

# WorkStep

### 让 AI 按步骤开发，关键结果由你把关

WorkStep 是面向个人开发者与小团队的 AI 开发工作台。连接 Codex、Claude Code 等 AI 编程工具，把需求分析、代码实现、测试和审查组织成可重复使用的流程。

[官网](https://xzregg.github.io/workstep/) · [下载](https://github.com/xzregg/workstep/releases/latest) · [操作手册](https://xzregg.github.io/workstep/#docs) · [开发文档](docs/README.md) · [English](README.md)

[![CI](https://github.com/xzregg/workstep/actions/workflows/ci.yml/badge.svg)](https://github.com/xzregg/workstep/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/xzregg/workstep?display_name=tag&style=flat-square)](https://github.com/xzregg/workstep/releases/latest)
[![License](https://img.shields.io/github/license/xzregg/workstep?style=flat-square)](LICENSE)
![本地优先](https://img.shields.io/badge/本地优先-是-22c55e?style=flat-square)
![桌面平台](https://img.shields.io/badge/桌面端-macOS%20ARM64%2Fx64%20%7C%20Windows%20x64%20%7C%20Linux%20x64-2563eb?style=flat-square)
![项目状态](https://img.shields.io/badge/状态-早期版本-f59e0b?style=flat-square)

</div>

## 用它完成什么？

例如，你想给现有项目增加搜索功能，可以配置一套流程：

1. **分析需求**：明确搜索范围和限制，输出实现计划。
2. **实现代码**：根据计划修改项目，说明改了哪些文件。
3. **运行测试**：执行约定的测试命令，记录结果与待处理问题。
4. **审查改动**：检查代码和测试结果；启用人工审核后，由你决定继续还是填写意见退回重做。

这是流程设计示例，实际结果需要检查。WorkStep 负责连接步骤、传递结果和记录过程；AI 的执行能力来自你配置的工具与模型。多个步骤可以共用一个引擎，不需要一次安装所有工具。

配置好的流程可以用于后续任务，减少反复交代背景、搬运结果和确认进度。

## 下载桌面版（推荐）

前往 [GitHub Releases](https://github.com/xzregg/workstep/releases/latest)，下载对应系统的安装包，安装后打开 WorkStep：

- **macOS Apple Silicon**：ARM64 DMG 或 ZIP
- **macOS Intel**：x64 DMG 或 ZIP
- **Windows x64**：NSIS 安装程序
- **Linux x64**：AppImage

桌面包内置后台，无需自行安装 Python。可选执行引擎在打开软件后按需安装。

> 桌面端目前是未签名的早期构建，首次运行可能出现 Windows SmartScreen 或 macOS Gatekeeper 提醒。

### 首次使用，需要准备什么？

1. 打开「设置 → 执行引擎」，先安装一个执行引擎，例如 Codex SDK 或 Claude Agent SDK。引擎就是实际读取文件、修改代码和调用工具的 AI 执行程序，可通过界面安装。
2. 按所选引擎要求配置认证与模型服务，测试通过后保存默认执行配置。安装 WorkStep 或引擎不会自动获得模型账号或凭据；模型服务费用按所选服务规则计算。
3. 添加一个项目，跟随新手引导创建「分析与执行」双步骤示例，再创建并启动任务。
4. 先完成一个容易检查的小任务，例如阅读演示材料并生成使用说明，核对文件后再用于自己的开发项目。

详细步骤见[首次使用指南](https://xzregg.github.io/workstep/#docs/getting-started)与[第一个任务](https://xzregg.github.io/workstep/#docs/first-task)。独立本地使用无需登录网关；外部模型服务仍需对应认证。

## 看图上手

以下为演示项目的真实界面截图，点击图片可查看原图。入门示例会读取演示材料，先生成执行计划，再新建一份使用说明；它帮助你检查步骤是否衔接、文件是否符合要求。完整步骤见[用户操作手册](https://xzregg.github.io/workstep/#docs)。

### 1. 下载 SDK，配置执行引擎

打开引擎设置，选择 SDK 引擎，通过「安装与版本」下载。配置认证后测试连接，再选择默认引擎；新用户推荐从 SDK 开始。

[![Codex SDK 安装、版本选择与连接测试界面](apps/landing/src/manual/screenshots/sdk-install-version.jpg)](apps/landing/src/manual/screenshots/sdk-install-version.jpg)

### 2. 在画布上连接步骤

添加步骤，连接输入与输出。图中把「需求分析」生成的 Markdown 执行计划传给「执行任务」，每个步骤都显示所用引擎。

[![流程画布：需求分析与执行任务通过 Markdown 输入输出连接](apps/landing/src/manual/screenshots/workflow-canvas.jpg)](apps/landing/src/manual/screenshots/workflow-canvas.jpg)

### 3. 创建任务，查看过程与结果

填写需求创建任务，逐步查看执行进度和对话。图中双步骤任务已完成，可以打开生成的执行计划和执行结果。

[![已完成的双步骤任务，展示执行记录与生成产物](apps/landing/src/manual/screenshots/first-task-result.jpg)](apps/landing/src/manual/screenshots/first-task-result.jpg)

### 4. 人工审核后再继续

为步骤启用人工审核，执行完成后会等待你的决定。检查输出、填写意见，再选择通过继续、驳回重做、完成步骤或终止任务。

[![等待人工审核的任务，包含审核意见、驳回重做与通过继续操作](apps/landing/src/manual/screenshots/task-review.jpg)](apps/landing/src/manual/screenshots/task-review.jpg)

## 核心能力

| | 能力 | 可以获得什么 |
|---|---|---|
| 🎛️ | **配置开发步骤** | 在工作流画布中组织串行、并行、审核和返工阶段，并复用流程模板。 |
| 🤖 | **选择 AI 编程工具** | 统一使用 CLI、SDK、ACP 和 Harness 引擎，不让流程绑定单一厂商。 |
| 👁️ | **查看执行过程** | 实时查看流式响应、工具调用、执行状态、结构化事件和步骤历史。 |
| 🛡️ | **人工确认与干预** | 审批敏感工具，暂停或终止任务，恢复会话，并重试失败阶段。 |
| 💾 | **本地优先存储** | 项目数据、执行记录和产物保存在你的设备或自管环境中。 |
| 🔁 | **上下文可恢复** | 在中断或重启后继续任务，并恢复受支持引擎的原生会话。 |
| 📦 | **Web 与桌面端** | 可从源码运行，也提供 macOS Apple Silicon / macOS Intel、Windows x64 和 Linux x64 早期安装包。 |
| 🔗 | **受控远程协作** | 按项目和设备授权远程访问，而不是默认把所有项目上传到中心化服务。 |

## 多种引擎，一套工作流

WorkStep 当前集成的引擎包括：

`Codex CLI` · `Codex SDK` · `Claude Code` · `Claude Agent SDK` · `OpenCode` · `OpenClaw` · `Hermes ACP` · `Cursor SDK` · `Qoder SDK` · `DeepSeek Harness` · `Pydantic AI`

先选择并配置一个即可。不同引擎支持的会话恢复、审批等能力可能不同，详见[引擎开发与能力说明](docs/llm-engine-development-guide.md)。

## 本地优先是怎样实现的

1. 项目数据和执行记录保存在本机；默认跟随项目目录，也可选择统一存储位置。
2. 引擎通过本地后台执行，WorkStep 不会静默把项目复制到托管工作区。
3. 可选的远程访问需要明确授权，按项目和设备隔离，并可由项目所有者撤销。

“本地优先”描述的是 WorkStep 对项目数据的存储与编排方式；外部模型服务及可选引擎仍遵循其各自的网络和数据策略。

## 其他运行方式（开发者与自部署用户）

### 从源码启动

环境要求：Python 3.11+、[uv](https://docs.astral.sh/uv/)、Node.js 20 或 22、Yarn（可通过 Corepack 提供），以及 Bash 和 `lsof`。适用于 macOS / Linux；Windows 推荐桌面包或 Docker。

```bash
git clone https://github.com/xzregg/workstep.git
cd workstep
./start.sh
```

脚本自动安装依赖并启动前后端，打开 <http://127.0.0.1:5173> 即可使用，按 `Ctrl+C` 停止。更多命令见[开发指南](docs/development.md)。

### Docker 启动

安装 Docker 和 Docker Compose，然后运行：

```bash
git clone https://github.com/xzregg/workstep.git
cd workstep
docker compose -f docker-compose.yaml up -d --build workstep
```

构建完成后打开 <http://localhost:8755>。配置和引擎保存在 `./data/home`，项目保存在 `./data/projects`；应用内创建项目时填写 `/data/projects/<项目名称>`。旧版 Compose 可将 `docker compose` 替换为 `docker-compose`，更多配置见[容器运行说明](docs/container-runtime.md)。

## 文档

- [用户操作手册：SDK 配置、流程、任务与常见问题](https://xzregg.github.io/workstep/#docs)
- [产品概览](docs/overview.md)
- [架构与数据流](docs/architecture.md)
- [工作流执行](docs/workflow-engine-execution.md)
- [LLM 引擎开发](docs/llm-engine-development-guide.md)
- [桌面沙箱模式](docs/desktop-sandbox.md)
- [开发指南](docs/development.md)
- [安全策略](SECURITY.md)

## 社区与贡献

提交拉取请求前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。可复现的缺陷和可执行的功能请求请提交到 [Issues](https://github.com/xzregg/workstep/issues)；问题讨论、想法与设计探索请使用 [Discussions](https://github.com/xzregg/workstep/discussions)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## Star 增长历史

<a href="https://www.star-history.com/?repos=xzregg%2Fworkstep&amp;type=date&amp;legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xzregg/workstep&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xzregg/workstep&amp;type=date&amp;legend=top-left" />
    <img alt="WorkStep GitHub Star 增长历史" src="https://api.star-history.com/chart?repos=xzregg/workstep&amp;type=date&amp;legend=top-left" width="800" />
  </picture>
</a>

## 许可证

WorkStep 使用 [Apache License 2.0](LICENSE)。可选的第三方引擎与服务遵循其各自条款，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
