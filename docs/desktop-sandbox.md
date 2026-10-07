# 桌面沙箱模式

[整体架构与生命周期流程图](diagrams/workstep-desktop-sandbox.html)展示桌面界面、Electron、Podman、容器 daemon 与持久化目录的职责和连接。

桌面「设置 → 沙箱」管理独立 Podman 环境。非桌面浏览器不显示此入口。
后台可以运行在应用自带的 Python 中，也可以运行在 WorkStep 容器镜像中。
模式和挂载变更通过桌面重启生效；任务或会话运行时拒绝切换，状态检查失败也拒绝切换。

## 使用与目录

首次选择空沙箱目录，或仅含已有 `home/`（允许 Finder 的 `.DS_Store`）的目录，以及一个已有的项目根目录。两者不能互相包含。接管已有 Home 时记录 `preserveHome: true`，重试与删除沙箱均保留 Home，删除只清理桌面创建的 `podman/` 和 `desktop/`。不能接管 Home 符号链接或夹杂其他内容的目录。复用 Compose 数据前应先停止其 WorkStep 容器。
可以添加额外项目目录，容器目标为 `/data/projects/<名称>`，默认根目录为 `/data/projects`。
点击「下载并准备沙箱」，完成后点击「开启沙箱并重启」。

```text
沙箱目录/
├─ podman/
│  ├─ bin/                 校验过的 Podman 和辅助程序
│  ├─ config/              独立连接、容器与存储配置
│  ├─ data/                镜像、容器和虚拟机磁盘
│  └─ cache/               下载缓存
├─ desktop/
│  ├─ owner.json           沙箱归属及项目挂载记录
│  ├─ sandbox.log          生命周期和失败记录，不保存桌面令牌
│  ├─ daemon.log           最近的容器输出，桌面令牌已脱敏
│  └─ backups/             配置导入前的备份
└─ home/                   挂载到容器 /root
   ├─ .workstep/runtime/
   ├─ .codex/
   ├─ .claude/
   ├─ .claude.json
   └─ .agents/
```

活动配置及未完成的初始化记录保存在 Electron `userData` 下，启动失败可重试、
切回非沙箱或退出。失败初始化保留所属目录，供再次准备或清理。
Unix 临时 socket/runroot 使用系统临时目录下的短路径，避免长沙箱路径超过 socket
长度限制；清理时一并删除。项目数据仍在项目目录内。

## 平台和分发

- macOS arm64/x64：校验并解包官方 Podman 5.6.2 安装包，不运行安装脚本、不安装系统服务；使用 AppleHV，显式共享 Home 和项目目录。
- Windows x64：下载官方 Podman 6.1.3 ZIP，使用系统 WSL2；缺少 WSL2 时引导启用。创建后检查所属 WSL 分发版的实际磁盘目录，位于沙箱外时拒绝继续启动。
- Linux x64：下载固定 SHA-256 的 [podman-static 6.1.3](https://github.com/mgoltzsche/podman-static) 社区静态发行包及辅助程序，使用 rootless、独立 vfs 存储和 OCI 配置。宿主仍需 uidmap、subuid/subgid、nsenter、用户命名空间及允许运行时的 AppArmor/SELinux 策略；不自动修改这些系统设置。
- 32 位 Windows 不提供沙箱能力。WSL、系统虚拟化等前置能力不会在删除沙箱时卸载。

固定下载 URL、版本及摘要位于 `sandbox-runtime.cjs`。升级这些内容时必须重新验证
对应平台的解包、辅助程序、机器启动和 Home 文件语义；归档内的上游文档随下载保留。
Podman 使用独立 XDG 配置及命名，不重用用户机器或修改用户默认连接。

桌面发布流程先构建并发布 `linux/amd64`、`linux/arm64` WorkStep 镜像，再将不可变
镜像摘要写入桌面包的 `sandbox-release.json`。首次发布后维护者须将 GHCR 包设置为公开，
让用户能够匿名拉取。发布前须确认该摘要能够匿名拉取。
源码中的镜像值为 `null`，不会假装存在尚未发布的镜像。开发时可设置
`WORKSTEP_SANDBOX_IMAGE` 为测试镜像引用；此覆盖只对未打包的 Electron 生效。
本地试用包的清单声明 `localDocker: true`，设置页提供“扫描本地 Docker”。Docker
需已安装并运行，桌面主进程只列出 Linux、当前 CPU 架构且带 WorkStep Home
入口的镜像。用户选择后按 Docker 不可变 ID 导出，导入独立 Podman 环境，
并从归档配置内容计算、核对 Podman 镜像 ID；成功或失败后均删除临时归档。
Docker 原镜像与容器保持不变，启用后的沙箱运行无需 Docker 持续运行。
未配置在线镜像时必须先选择本地镜像；正式发布包仍使用固定在线摘要。
本地导入路径已在 macOS ARM64 使用受管理 Podman 5.6.2 实测：扫描、Docker
归档导出、配置摘要核对、Podman 导入、虚拟机停启、容器健康检查（200 / ok）
和自有资源删除均通过；Windows 与 Linux 的本地导入尚未完成实机验收。
手工 Docker Compose 继续使用 `workstep:latest`。

## 配置、权限和清理

Codex、Claude、共享配置的导入按钮只读取宿主 Home 对应的固定目录；复制前完成
暂存，已有目标移动到备份，失败恢复目标。跳过符号链接、缓存、临时文件和锁文件。
不自动移动宿主引擎二进制，也不盲目改写配置中的绝对路径；必要时重新配置挂载路径。
导入必须在关闭沙箱并重启到非沙箱后进行。

默认容器只挂载 Home 和列出的项目目录，端口仅绑定 `127.0.0.1`，使用临时桌面令牌。
不暴露容器管理 socket，不使用 privileged。Codex 等内层沙箱确有兼容需求时，
可显式勾选兼容权限（SYS_ADMIN 和关闭 seccomp）；界面说明隔离强度会降低。
企业桌面的签名网关配置额外以只读方式挂载，宿主路径转换为容器内固定位置。

关闭模式保留 Home 和下载；删除必须先关闭沙箱并重启。删除只针对归属记录匹配的
目录、容器和机器；先移除系统注册，再清理目录，项目保持不动。
Windows 上不要直接删除目录代替清理按钮，否则可能留下 WSL 注册。

## 验证

- 桌面 Node 测试覆盖下载校验、路径与符号链接、IPC 来源和目录授权、活动工作保护、失败准备、重启保留、配置导入备份与专属资源清理。
- 前端行为测试覆盖明确准备、下载错误重试、切换确认、浏览器隐藏入口；字典测试检查语言键一致。
- 2026-10-06 已在 macOS arm64 实测官方安装包下载、SHA-256、无安装解包、AppleHV 初始化/启停、本地 WorkStep 镜像加载、容器健康及接口鉴权、配置导入、runtime 和项目重启保留、专属资源删除。清理后未发现测试进程，项目文件保留。
- 实测接口：`GET /api/health`、`GET /api/engine/list`、`GET /api/templates/list`、`POST /api/project/init`、`GET /api/project/list` 均为 200；不带桌面令牌的项目列表请求为 401。
- 实测路径：Python 为 `/app/apps/daemon/.venv/bin/python`（3.14.8），Node 为 `/root/.workstep/runtime/base/bin/node`（24.21.0）；npm、uv、git 及容器内 Codex 测试配置读取通过。未使用宿主真实引擎凭据，未调用付费模型。
- 此次修复：Podman 5.6.2 的 machine 命令不支持新版 provider/update-connection 参数，macOS 使用独立配置指定 provider；Fedora CoreOS 共享目标使用 `/var/mnt`，避免 `/mnt` 符号链接使 systemd 挂载失败；已校验镜像种子的 tar 解包保留可信链接目标，避免 rootless virtiofs 无法打开模式 000 的链接占位文件。
- 实测使用本地 `workstep:latest` 加更新后的入口脚本构建的临时镜像，未覆盖正式发布镜像匿名拉取、全量镜像重建、Electron 界面端到端切换、引擎下载及模型执行。Windows/Linux 仍需要各平台实机验证；离线测试不替代实机验收。

完整实机验收应包含空 Home 初始化、CLI/SDK 调用、含空格路径、额外挂载、断网重启、
镜像升级保留数据、关闭应用停止资源、删除后无专属机器注册及现有 Podman 环境不受影响。
