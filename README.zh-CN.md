# WorkStep

[English](README.md) · [官网](https://xzregg.github.io/workstep/) · [文档](docs/README.md) · [讨论区](https://github.com/xzregg/workstep/discussions)

> 一个本地优先的工作流编排工具，把 Codex、Claude Code、ACP Agent 等多个 LLM 引擎串成可观察、可复用的研发流水线。

[![CI](https://github.com/xzregg/workstep/actions/workflows/ci.yml/badge.svg)](https://github.com/xzregg/workstep/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/xzregg/workstep?display_name=tag)](https://github.com/xzregg/workstep/releases)
[![License](https://img.shields.io/github/license/xzregg/workstep)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB)](apps/daemon/pyproject.toml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)](apps/web/package.json)

WorkStep 将项目和执行数据保留在本机，同时为任务提供结构化流程、实时 Agent 输出、审批边界与可恢复上下文。仓库包含 FastAPI 后台、React 前端及 macOS、Windows、Linux 桌面应用。

## 核心能力

- 本地优先，每个项目使用独立 SQLite 数据库。
- 可视化工作流，支持并行阶段和可复用模板。
- 多种执行引擎统一到同一套会话与事件模型。
- 实时输出、工具审批、暂停恢复与会话续接。
- 可选的远程项目分享，不把本地后台变成托管服务。

## 快速开始

需要 Python 3.11+、[uv](https://docs.astral.sh/uv/) 和 Node.js 20+。

```bash
git clone https://github.com/xzregg/workstep.git
cd workstep
./start.sh
```

然后打开 `http://127.0.0.1:8765`。开发命令和仓库规范见[开发指南](docs/development.md)。

## 桌面端下载

创建 `v*` 标签后，GitHub Release 会自动生成 macOS Apple Silicon、macOS Intel、Windows x64 和 Linux x64 四种桌面包。早期版本暂未签名，系统首次打开时可能要求手动确认。请前往 [GitHub Releases](https://github.com/xzregg/workstep/releases) 下载。

## 文档入口

- [架构与数据流](docs/architecture.md)
- [开发指南](docs/development.md)
- [GitHub 仓库设置](docs/github-settings.md)
- [安全策略](SECURITY.md)
- [支持与提问](SUPPORT.md)

## 参与贡献

提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。可复现缺陷和明确需求进入 Issues；使用问题、想法和设计讨论进入 [Discussions](https://github.com/xzregg/workstep/discussions)。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## Apache-2.0 有什么不一样？

它允许商业使用、修改和分发，并明确提供贡献者专利授权；再分发时需要保留许可证、版权和 NOTICE 信息，并说明你修改过的文件。它不要求衍生项目必须开源。可选的第三方引擎仍遵循各自条款，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
