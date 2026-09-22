# 引擎安装、版本选择与回退

设置 → 执行引擎 → **安装与版本**提供主包大小、确切版本选择、安装过程和上一版本回退。适用于 Codex CLI、Claude Code CLI，以及 Codex、Claude、Qoder、DeepSeek Harness SDK。Pydantic AI 随项目依赖管理；Hermes、OpenClaw 仍由外部安装方式管理。

## 版本来源与约束

每个引擎在自己的适配器文件中声明 `RUNTIME_PACKAGE`（`engines/core/packages.py: RuntimePackage`），包括包名、PyPI/npm 来源、最低版本及可选默认版本。无需在前端维护包名或支持列表；引擎列表中的 `runtime_manageable` 控制入口。

- PyPI 仅列出满足本机 Python、平台 wheel 标签和最低版本要求的非撤回安装包；不自动构建源码包。
- npm 从官方 registry 读取版本和发布标签；Node 兼容性和依赖安装由 npm 最终校验。
- Codex SDK 最低 `0.147.0`、Claude SDK 最低 `0.1.0`、Qoder SDK 最低 `1.0.11`。DeepSeek Harness 最低及首次默认版本为 `0.1.0rc6`，可以显式选择更新版本。
- 列表标记预发布版本；可选版本表示包可获取，不代表每个版本都经过 WorkStep 兼容性验证。
- 使用自定义可执行文件路径时禁用版本切换，避免更新其他位置的程序。清除路径配置后才能使用包管理。

## 大小与进度口径

`services/engine_runtime.py` 直接下载选定的主安装包，下载前读取 PyPI 的 `size`，下载时读取 HTTP Content-Length 并按实际接收字节累计。npm 未提供压缩包大小时，在下载响应到达前显示大小未知；不把 `unpackedSize` 当作下载大小。

仅主包下载阶段显示「已下载 / 总大小」和百分比。总大小未知时只显示已下载量；读取元数据、安装依赖、解压和版本校验阶段显示持续活动状态，不产生模拟百分比。主包下载达到 100% 不表示安装完成。

下载安装包会校验仓库提供的 SHA-256（PyPI）或 SRI/SHA 摘要（npm），失败时不运行安装命令。实现依据：[PyPI JSON API](https://docs.pypi.org/api/json/)、[npm 本地压缩包安装](https://docs.npmjs.com/cli/v11/commands/npm-install/)。

## 安装与恢复

安装使用下载后的本地 wheel/tarball，确保主包版本固定。Python SDK 安装进入运行 daemon 的环境；桌面版设置 `WORKSTEP_ENGINE_PACKAGE_DIR` 时，先复制共享包目录到临时目录，在临时目录执行 pip，再按安装报告清理被替换的旧版本元数据。临时目录版本校验通过后才切换正式目录，安装失败保留原目录。

安装结束会检查实际包版本/CLI 版本与目标是否一致，并清除引擎测试通过状态。SDK 已导入的模块不会热重载：需要重启后台服务、重新扫描和测试后使用新版本。

操作在 daemon 后台运行，关闭面板或刷新页面不会取消。进度查询失败时前端自动重试，避免误报失败后立即启动第二次安装。所有受管理安装和旧安装接口共享进程内互斥，忙时返回 409。

每个引擎的记录位于 `$WORKSTEP_CONFIG_DIR/engine-runtimes/<engine_id>.json`，未配置时为 `~/.workstep/engine-runtimes/`：

- 变更前保存回退版本；失败重试不覆盖原来的恢复目标。
- 保存最近 20 次成功的版本变更和最后一次操作状态。
- 先保存最终结果，再向查询端报告完成。
- daemon 重启后的未完成操作显示为中断，可重试或回退。

回退重新获取并安装变更前的确切主包版本。历史恢复目标可以低于当前最低版本，以支持恢复已有旧安装；仍须有适配当前 Python/平台的可下载包。回退需要网络与包仓库继续提供该版本，依赖会重新解析，**不是整个环境的离线快照还原**。

## API 与测试

- `GET /api/engine/{id}/runtime`：当前版本、默认版本、可选版本、主包大小、条款、历史和回退目标；仓库暂时不可用时保留本地历史并返回 `error`。
- `GET /api/engine/{id}/runtime/operation`：当前或最近一次操作，没有记录时返回 `null`。
- `POST /api/engine/{id}/runtime/operation`：`{version, rollback: false, accept_third_party_terms}` 安装；`{rollback: true, accept_third_party_terms}` 恢复服务器保存的上一版本；接受任务后返回 202。
- 原 `/install`、`/update` 为旧客户端保留，不提供新版本选择、下载进度和历史保证；新界面统一使用 runtime API。

前端组合模块为 `EngineRuntimeControl`；`SettingsPage` 只负责按能力组装和完成后的引擎刷新。`EngineInstallProgress` 只展示测量数据。测试：`tests/test_engine_runtime.py`（离线 registry/安装器边界及真实流式字节）、前端 `engineRuntimeControl.test.tsx` 与 `engineInstallProgress.test.tsx`。
