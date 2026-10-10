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

If a secret is ever committed, revoke it before rewriting Git history. Coordinate
history rewriting with contributors and forks; deleting a branch or force-pushing
does not itself revoke a credential.
