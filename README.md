# WorkStep

[简体中文](README.zh-CN.md) · [Website](https://xzregg.github.io/workstep/) · [Documentation](docs/README.md) · [Discussions](https://github.com/xzregg/workstep/discussions)

> A local-first workflow orchestrator that connects Codex, Claude Code, ACP agents, and other LLM engines into visible, reusable development pipelines.

[![CI](https://github.com/xzregg/workstep/actions/workflows/ci.yml/badge.svg)](https://github.com/xzregg/workstep/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/xzregg/workstep?display_name=tag)](https://github.com/xzregg/workstep/releases)
[![License](https://img.shields.io/github/license/xzregg/workstep)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB)](apps/daemon/pyproject.toml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)](apps/web/package.json)

WorkStep keeps projects and execution data on your machine while giving every task a structured workflow, live agent output, approval boundaries, and resumable context. It ships a FastAPI daemon, a React web interface, and desktop packages for macOS, Windows, and Linux.

## Highlights

- Local-first projects with per-project SQLite storage.
- Visual workflow orchestration with parallel stages and reusable templates.
- Multiple engines behind one execution and event model.
- Live task output, tool approval, pause/resume, and session recovery.
- Optional remote project sharing without turning the local daemon into a hosted service.

## Quick start

Requirements: Python 3.11+, [uv](https://docs.astral.sh/uv/), and Node.js 20+.

```bash
git clone https://github.com/xzregg/workstep.git
cd workstep
./start.sh
```

Then open `http://127.0.0.1:8765`. Development commands and repository conventions live in the [development guide](docs/development.md).

## Desktop downloads

Tagged releases publish unsigned early-access builds for macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64. Download them from [GitHub Releases](https://github.com/xzregg/workstep/releases). Your operating system may require an explicit confirmation before opening an unsigned build.

## Documentation

- [Architecture and data flow](docs/architecture.md)
- [Development guide](docs/development.md)
- [GitHub maintainer settings](docs/github-settings.md)
- [Security policy](SECURITY.md)
- [Support and questions](SUPPORT.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Use Issues for reproducible bugs and actionable feature requests; use [Discussions](https://github.com/xzregg/workstep/discussions) for questions, ideas, and design exploration. Security reports must follow [SECURITY.md](SECURITY.md), not public Issues.

## License

WorkStep is licensed under [Apache License 2.0](LICENSE). It includes an express patent grant and requires preservation of license and notice information when redistributed. Optional third-party engines and services remain under their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
