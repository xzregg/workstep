# Release checklist

Desktop releases are built only from an existing semantic-version tag such as
`v1.2.3`. The `release` GitHub Environment is the approval gate for creating a
draft release.

## 统一应用版本号

桌面端是 daemon 的包装，两者使用同一应用版本。版本修改入口为 `apps/desktop/package.json` 的 `version`，不得分别维护 daemon 版本。发布前在 `apps/desktop` 执行（示例版本）：

```bash
npm version 1.0.11 --no-git-tag-version
```

`postversion` 自动运行 `scripts/sync-app-version.cjs`，同步 `apps/daemon/pyproject.toml` 和 `apps/daemon/uv.lock`。如果手动编辑 manifest，在仓库根执行 `node scripts/sync-app-version.cjs`。将这些变更一起提交；发布标签必须与应用版本一致，例如 `1.0.11` 对应 `v1.0.11`。

发布前在 `apps/daemon` 执行 `uv run --no-sync pytest tests/test_runtime_version.py tests/test_gateway_control_client.py -q`，核对源码启动、打包运行时和网关心跳版本。桌面后端打包会生成 `app/daemon/app-version.json`；`WORKSTEP_BUILD_VERSION`、启动器的 `WORKSTEP_VERSION` 必须与目标发布标签对应，不能以网关最新版本代替实际运行版本。运行时来源详见 [开发文档](development.md#应用版本号)。

版本变更须进入本批交付提交，按仓库约定通过“合并到 main”快捷按钮合并到本地 `main` 并返回 `dev`。远端推送、创建及推送标签、发布 GitHub Release 按用户指令执行。

Before tagging:

1. Ensure CI passes, including repository-health and full-history secret scans.
   Verify the website user manual against the merged, committed release version.
   Manual updates are batched only when merging `dev` into local `main` and
   committing the delivery, alongside the verified user-facing changes; individual
   features during development do not trigger this process. At that checkpoint,
   update instructions and real, sanitized screenshots using the fixed demo project
   on local port `8777` (see [demo environment](manual-demo.md)), and run
   `yarn --cwd apps/landing manual:check`, tests and build. If release review finds
   omissions, batch the affected corrections before publishing. Record screenshot
   gaps and do not claim completion while they remain; do not document planned
   features as available. The SDK-first setup path must still work on a clean installation.
2. Review Dependabot alerts and dependency changes in all lockfiles.
3. Confirm that the release is intentionally unsigned. The workflow disables
   macOS identity discovery and notarization and disables Windows code signing,
   so it requires no certificate or Apple account secrets. Expect Windows
   SmartScreen and macOS Gatekeeper warnings during clean-machine validation.
4. Confirm GitHub secret scanning, push protection, private vulnerability
   reporting, branch rulesets, and the `release` Environment are enabled.
5. Create and push the version tag. Do not reuse or move a published tag.

The workflow publishes a sandbox image for Linux amd64 and arm64 to GHCR under
the release tag and `latest`, and pins its immutable digest into every desktop package.
It creates unsigned installers for Windows x64, macOS arm64 and Linux x64, updater metadata,
SHA-256 checksums, and a CycloneDX SBOM. It then creates a draft
Release. Before publishing the draft, install every platform artifact on a clean
machine and verify first launch, sidecar startup, deep links, task execution,
the Settings desktop version check and GitHub download link, upgrade, and uninstall behavior.
Desktop updates only query the latest published GitHub Release daily; packages are
downloaded and installed manually. Publishing the draft is an explicit release step.

## Windows 安装包自动验收

`Desktop release` 的 Windows job 在上传安装包前，调用
`scripts/windows-desktop-acceptance.cjs` 验证实际 NSIS 包；失败会阻止创建发布草稿。
它在 GitHub `windows-2025` 临时 runner 内安装到含中文和空格的路径，检查首次启动、
内置 daemon 健康及版本、实际任务列表／设置界面、桌面认证边界、占用端口回退、
`workstep://open` 深链接、退出时后台停止、重启后项目／任务／记忆保留和卸载后数据保留。
还会下载上一个正式版，验证原安装包升级后的数据保留。

已发布包可独立补测：运行 `Desktop package smoke`，`ref` 指向验收脚本所在分支，
设置 `acceptance_tag=v1.0.11`、`previous_tag=v1.0.10`。填写 `acceptance_tag` 时只运行
Windows 验收，下载原 Release 的 EXE 和 `SHA256SUMS.txt`；不重新打包、移动标签或修改附件。
脚本拒绝在开发者本机启动，演示配置、项目和用户数据均位于 runner 的临时目录。
Playwright 仅作为开发依赖，通过临时回环调试端口连接实际窗口，不修改正式包的安全 fuses。

无论成功失败都会上传 `windows-acceptance-evidence`（报告、窗口截图、进程日志，保留 14 天）；
不上传配置、数据库、请求头或网络 trace。流程不调用真实 LLM，也不需要供应商密钥。
空工作流中的任务用于验证 CRUD 和持久化，不代表引擎执行已验收。
Windows Server 的自动检查不能替代 Windows 10/11 实机的 SmartScreen、托盘／系统通知、
原生目录选择／外部浏览器、真实认证引擎执行和 WSL2/Podman 沙箱检查；这些缺口继续登记。
更新设置的界面／IPC 检查使用临时用户目录中的可控 Release 缓存，避免共享 runner IP 的匿名
GitHub API 限流；不将其宣称为在线更新请求或浏览器下载跳转验收。

### v1.0.11 原始 Windows 包补测结果

2026-10-11 的 [GitHub 验收记录](https://github.com/xzregg/workstep/actions/runs/38067287127)
使用已发布原 EXE，并核对发布校验清单。中文／空格路径安装、首次启动、内置 daemon
版本、桌面 IPC 和业务接口认证检查通过；保存中文使用者名称时
`PUT /api/system-settings` 返回 500，整体验收失败，后续任务、重启、升级和卸载检查未执行。
原包内置 Python 的隔离复现确认：`ConfigStore._save()` 未指定文本编码，Windows runner
默认 `cp1252` 导致 `UnicodeEncodeError`。不能将该版本标为 Windows 功能验收通过，
也不能通过给验收进程强制设置 `PYTHONUTF8=1` 来掩盖正式启动路径的错误。
修复应进入新版本，再完整补测；已发布的 v1.0.11 标签和附件保持不变。

If a secret is ever committed, revoke it before rewriting Git history. Coordinate
history rewriting with contributors and forks; deleting a branch or force-pushing
does not itself revoke a credential.
