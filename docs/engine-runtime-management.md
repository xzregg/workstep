# 引擎安装、版本选择与回退

设置 → 执行引擎 → **安装与版本**提供主包大小、确切版本选择、安装过程和上一版本回退。适用于 Codex CLI、Claude Code CLI，以及 Codex、Claude、Qoder、DeepSeek Harness、Tau 和 Antigravity ACP。Pydantic AI 随项目依赖管理；Hermes、OpenClaw 仍由外部安装方式管理。

Antigravity ACP（`antigravity`）通过同一“安装与版本”面板安装官方 `agy` 原生程序，目标固定为 `$WORKSTEP_CONFIG_DIR/runtime/native/antigravity/agy`（默认 `~/.workstep/`，Windows 为 `agy.exe`）。不执行官方 shell／PowerShell 安装器，不写 `~/.local/bin`、系统目录、PATH 或 shell 配置。路径优先级为显式配置／`ANTIGRAVITY_BIN`、WorkStep 托管目录、宿主机已有 CLI；显式路径启用时禁止托管版本切换。版本面板只把托管目录中的程序计为已安装版本，宿主同版本 CLI 不会阻止安装独立副本。CLI 自己管理账号认证，WorkStep 不复制 IDE 凭据。安装后展开引擎配置，在“账号登录”点击“登录账号”，打开浏览器授权，再粘贴授权码或授权后的完整 URL，点击“完成登录”；也可在终端运行同一完整路径的 `agy acp --login`。登录后刷新模型目录，选择模型并测试连接。

桌面容器沙箱中的登录进程由容器内 daemon 启动，授权链接通过桌面壳打开本机浏览器，输入的授权码返回同一容器进程。原生凭据由 CLI 保存，复用沙箱既有 `/root` 持久化挂载；不能把宿主机钥匙串或配置目录直接视为容器登录态。取消、超时及 daemon 关闭会回收登录进程，授权码不写入引擎配置或诊断日志。

原生版本来源是[官方安装器](https://antigravity.google/docs/getting-started/)使用的平台发布清单，平台覆盖 macOS／Windows／Linux 的 x64 与 arm64（Linux 含 musl）。官方下载仅提供当前版本清单，因此版本列表显示当前官方版本和 WorkStep 已记录的同平台确切版本，不虚构完整历史目录。操作记录保存不可变下载地址、大小和 SHA-512，供重试与回退；接管前的外部安装若没有相应清单，不声明可回退。下载复用 `ResourceDownload` 断点续传和真实字节进度；校验通过后只提取已知普通可执行文件，在托管目录内暂存并验证版本，再原子替换。失败保留原程序，不随桌面包或镜像预装。

## Tau 的内置适配与按需安装

Tau 的适配代码随 WorkStep 提供，但官方 `tau-ai` SDK 及其依赖不随 daemon／桌面包预装，也不加入应用的 `pyproject.toml` 或 `uv.lock`。未安装时仍可在设置 → 执行引擎看到 Tau；由用户打开“安装与版本”、选择版本并确认后才下载到可写的 Python 引擎运行时目录。列表扫描和应用启动不触发安装。需要 Python 3.12 或更新版本；当前适配已验证 SDK 0.4.12。包仓库的可选版本不等于全部经过兼容性验证。

从原自定义 Tau 接入升级时，保留引擎 ID `tau`、供应商选择和模型；`tau_engine` 配置覆盖旧 `custom_engine_config.tau` 中的同名参数，未覆盖项继续兼容读取。已有的 `runtime/engines/tau/dependencies/python` SDK 可原地复用；之后手动安装的托管 SDK 优先。原生会话继续使用 `runtime/engines/tau-sessions`，不迁移或删除历史文件。内置类优先于同 ID 自定义包，不再经用户包加载适配代码。

图片直接作为原生内容块传递，正文路径保留；默认网络无数据超时为 300 秒，单次模型请求总时限 900 秒，bash 上限 300 秒，均可保存或按轮覆盖。空回复、断流、截断和轮数耗尽不报告成功。恢复、审批、实时消息、工具禁用和取消清理有离线 SDK 回归；SDK 更新后需重启后台、重新扫描及测试。

## 版本来源与约束

每个引擎在自己的适配器文件中声明 `RUNTIME_PACKAGE`（`engines/core/packages.py: RuntimePackage`），配置包名及 PyPI/npm/native 来源。无需在前端维护包名或支持列表；引擎列表中的 `runtime_manageable` 控制入口。

- PyPI 仅列出满足本机 Python、平台 wheel 标签和最低版本要求的非撤回安装包；不自动构建源码包。
- npm 从官方 registry 读取版本和发布标签；Node 兼容性和依赖安装由 npm 最终校验。
- native 由 `services/antigravity_runtime.py` 读取官方平台清单、限定下载来源、提取和验证单文件程序；统一 runtime 管理操作、进度、互斥与历史。
- 所有受管理引擎不在代码中固定业务版本；首次安装和更新默认采用包仓库的 `latest`，也可以显式选择仓库返回的兼容版本。
- 列表标记预发布版本；可选版本表示包可获取，不代表每个版本都经过 WorkStep 兼容性验证。
- 使用自定义可执行文件路径时禁用版本切换，避免更新其他位置的程序。清除路径配置后才能使用包管理。

## 大小与进度口径

`services/engine_runtime.py` 直接下载选定的主安装包，下载前读取 PyPI 的 `size`，下载时读取 HTTP Content-Length 并按实际接收字节累计。npm 未提供压缩包大小时，在下载响应到达前显示大小未知；不把 `unpackedSize` 当作下载大小。

仅主包下载阶段显示「已下载 / 总大小」和百分比。总大小未知时只显示已下载量；读取元数据、安装依赖、解压和版本校验阶段显示持续活动状态，不产生模拟百分比。主包下载达到 100% 不表示安装完成。

下载安装包会校验仓库提供的 SHA-256（PyPI）、SRI/SHA 摘要（npm）或 SHA-512（Antigravity 官方清单），失败时不运行安装命令。实现依据：[PyPI JSON API](https://docs.pypi.org/api/json/)、[npm 本地压缩包安装](https://docs.npmjs.com/cli/v11/commands/npm-install/)。

## 安装与恢复

引擎安装、更新、回退及配置管理属于宿主能力，不要求 Gateway 的 `engine.install` 权限，也不依赖网关策略快照。接口仍需通过原有身份认证和宿主访问检查；仅获得单个项目访问权的账号不能修改整机引擎。

安装使用下载后的本地 wheel/tarball，确保主包版本固定。Python SDK 按需安装到 `~/.workstep/runtime/python-packages`（可用 `WORKSTEP_ENGINE_PACKAGE_DIR` 覆盖），不进入 uv 管理的虚拟环境，也不写入 `uv.lock`。安装时先复制共享包目录到临时目录，通过 pip 或 uv 安装并清理被替换的旧版本元数据；临时目录版本校验通过后才切换正式目录，安装失败保留原目录。

桌面非沙箱模式由 `apps/desktop/backend/server.py` 在启动后台前统一安装环境：npm CLI 安装到 `$WORKSTEP_CONFIG_DIR/runtime/npm`（默认 `~/.workstep/runtime/npm`），uv 解释器下载到 `runtime/base/python`，uv 安装目标为 `runtime/base/bin`。这些 CLI 优先进入 PATH，Python 包目录同时进入后台 `sys.path` 与子进程 `PYTHONPATH`。Windows 使用 npm prefix 本身作为命令目录，macOS/Linux 使用其 `bin`。宿主机已有引擎继续作为回退，不自动迁移；daemon 自带 Python 随桌面安装包更新。容器采用同样的 Home 相对安装结构。

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

前端组合模块为 `EngineRuntimeControl`；`SettingsPage` 只负责按能力组装和完成后的引擎刷新。`EngineInstallProgress` 只展示测量数据。测试：`tests/test_engine_runtime.py`（离线 registry/安装器边界及真实流式字节）、`test_antigravity_runtime.py`（托管路径、版本校验、回退、断点续传和慢解压 canary）、前端 `engineRuntimeControl.test.tsx` 与 `engineInstallProgress.test.tsx`。
