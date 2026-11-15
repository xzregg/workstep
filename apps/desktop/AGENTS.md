# 桌面端开发指导

适用于 `apps/desktop/`，同时遵守[根规则](../../AGENTS.md)。

- 开发与打包命令以 [README.md](README.md) 和 `package.json` 为准。
- 界面先读 [DESIGN.md](../../DESIGN.md)，完成受影响界面的实际渲染检查并报告范围和缺口；内嵌 Web 的改动同时读取 [Web 规则](../web/AGENTS.md)，内置后端改动同时读取 [Daemon 规则](../daemon/AGENTS.md)。
- 桌面端与 daemon 共用应用版本，版本同步、标签及发布必须遵守[发布规范](../../docs/releasing.md#统一应用版本号)，不得独立改版本或保留固定旧版本兜底。
- 打包前必须阅读[发布内容检查](../../docs/releasing.md#release-payload-hygiene)，遵守根规则中的敏感信息约束。
- 桌面运行目录通过 `scripts/package_payload.py copy` 过滤复制，完成后用 `check` 扫描；Electron 打包钩子复核实际注入文件。Docker 同时维护 `.dockerignore` 和运行目录检查，禁止只依赖 Git 忽略规则。
