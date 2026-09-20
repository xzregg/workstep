# WorkStep

[English](README.md) · [官网](https://xzregg.github.io/workstep/) · [文档](docs/README.md) · [讨论区](https://github.com/xzregg/workstep/discussions)

> 一个本地优先的工作流编排工具，把 Codex、Claude Code、ACP Agent 等 LLM 引擎连接成可观察、可复用的研发流水线。

[![CI](https://github.com/xzregg/workstep/actions/workflows/ci.yml/badge.svg)](https://github.com/xzregg/workstep/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/xzregg/workstep?display_name=tag)](https://github.com/xzregg/workstep/releases)
[![License](https://img.shields.io/github/license/xzregg/workstep)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB)](apps/daemon/pyproject.toml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)](apps/web/package.json)

![WorkStep 工作流工作台](apps/web/src/assets/hero.svg)

WorkStep 将项目和执行数据保存在本机，同时为任务提供结构化工作流、实时 Agent 输出、审批边界和可恢复上下文。仓库包含 FastAPI 后台、React Web 应用，以及 macOS、Windows 和 Linux 桌面打包。

## 核心能力

- 本地优先，每个项目使用独立 SQLite 数据库。
- 可视化工作流，支持并行阶段和可复用模板。
- 多种执行引擎统一到同一套执行与事件模型。
- 实时任务输出、工具审批、暂停恢复与会话续接。
- 可选的远程项目分享，不把本地后台变成托管服务。

## 快速开始

环境要求：Python 3.11+、[uv](https://docs.astral.sh/uv/) 和 Node.js 20+。

```bash
git clone https://github.com/xzregg/workstep.git
cd workstep
./start.sh
```

启动后访问 `http://127.0.0.1:8765`。开发命令和仓库约定见[开发指南](docs/development.md)。

## 桌面版下载

带标签的发布版本会提供 macOS Apple Silicon、macOS Intel、Windows x64 和 Linux x64 的早期构建。Windows 产物使用 Authenticode 签名；macOS 签名与公证目前不作保证。安装包、校验和、SBOM 与来源证明可从 [GitHub Releases](https://github.com/xzregg/workstep/releases) 下载。打开未签名的 macOS 构建时，系统可能要求额外确认。

## 文档

- [架构与数据流](docs/architecture.md)
- [开发指南](docs/development.md)
- [GitHub 维护设置](docs/github-settings.md)
- [安全策略](SECURITY.md)
- [支持与问题反馈](SUPPORT.md)

## 参与贡献

提交拉取请求前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。可复现的缺陷和可执行的功能请求请提交到 Issues；问题讨论、想法与设计探索请使用 [Discussions](https://github.com/xzregg/workstep/discussions)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要发布到公开 Issue。

## 许可证

WorkStep 使用 [Apache License 2.0](LICENSE)。该许可证包含明确的专利授权，并要求再分发时保留许可证和通知信息。可选的第三方引擎与服务遵循其各自条款，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
