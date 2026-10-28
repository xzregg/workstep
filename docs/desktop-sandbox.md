# 桌面沙箱模式

[整体架构与生命周期流程图](diagrams/workstep-desktop-sandbox.html)展示桌面界面、Electron、Podman、容器 daemon 与持久化目录的职责和连接。

桌面「设置 → 沙箱」管理独立 Podman 环境，入口位于设置导航最下面。非桌面浏览器不显示此入口。
后台可以运行在应用自带的 Python 中，也可以运行在 WorkStep 容器镜像中。
模式和挂载变更通过桌面重启生效；任务或会话运行时拒绝切换，状态检查失败也拒绝切换。

## 使用与目录

首次选择空沙箱目录，或仅含已有 `home/`（允许 Finder 的 `.DS_Store`）的目录，以及一个已有的项目根目录。两者不能互相包含。接管已有 Home 时记录 `preserveHome: true`，重试与删除沙箱均保留 Home，删除只清理桌面创建的 `podman/` 和 `desktop/`。不能接管 Home 符号链接或夹杂其他内容的目录。复用 Compose 数据前应先停止其 WorkStep 容器。
可以添加额外项目目录，容器目标为 `/data/projects/<名称>`，默认根目录为 `/data/projects`。
沙箱会把 `/data/projects` 作为后台的项目访问边界：项目选择器从这里开始且不能向上浏览，
新建目录、设置默认项目目录、初始化及导入项目都拒绝该边界外的路径。
设置按五步完成：辅助软件 → 镜像 → 项目目录 → 迁移配置 → 确认。
非沙箱后台有任务时仍可准备辅助软件与镜像；运行中的沙箱禁止重新准备，正式切换模式仍须确认没有运行工作。
先选择沙箱存储目录并下载、校验 Podman；Windows 同时检查 WSL2。镜像步骤检查并准备
虚拟机基础环境以及版本、架构、WorkStep 入口匹配的容器镜像，也可扫描本地 Docker 导入。
在线发布镜像可保存为主机目录中的 OCI 归档及 SHA-256 清单，断网重试时校验并复用缓存。
本地 Docker 镜像切换直接导入 Podman 一次，并用镜像配置摘要与 Podman inspect 核对身份；
不再额外生成、哈希和重新加载第二份 OCI 缓存。相同 Docker 镜像 ID 已存在于 Podman 时直接
复用；若 Podman 存储被清理或机器重建，则自动回退到重新导入。切换成功后保持专属机器运行并
直接启动容器，导入失败时停止机器且保留待切换记录供重试。日常启动复用已安装软件及已准备镜像。
新建虚拟机磁盘上限为 64 GiB，为镜像切换时的旧镜像、上传归档和解包临时文件预留空间；
macOS 既有较小虚拟机在准备阶段通过 Podman 原地扩容，不删除镜像、容器或卷，也不缩小更大的磁盘。
启动后还会核对 `/var` 的实际文件系统容量，不能仅依赖 Podman 报告的虚拟磁盘大小；
旧机器根分区/XFS 未随磁盘扩容时，使用来宾自带的 `growpart` 和 `xfs_growfs` 补齐并复查，
未达到预期则停止准备并保留原数据，避免继续导入镜像后才报告空间不足。
Windows WSL2 沿用系统的虚拟磁盘增长机制，不执行 macOS 扩容路径。缓存恢复前先检查镜像是否已存在，
避免重复加载。空间耗尽时明确提示 Podman 存储或临时目录空间不足；清理 Docker 不会释放独立 Podman 存储。
2026-10-28 本机受管理 Podman 5.6.2 / AppleHV 排查确认：磁盘文件及资源配置已为 64 GiB，
但 GPT 根分区及 XFS 仍为约 19.5 GiB；先前仅核对资源配置不能证明来宾可用容量已增加。
使用上述修复函数实机扩容后，`df -h /var /var/tmp` 从约 20 GiB 总量、1.5 GiB 空闲变为
64 GiB 总量、45 GiB 空闲；此前失败的本地 Docker 镜像随后完整导入并通过配置摘要校验，
导入后仍有约 44 GiB 空闲。验证完成后停止专属虚拟机，未启动应用容器；
本次证据覆盖文件系统扩容及镜像导入，未覆盖 Electron 界面端到端切换或新版安装包。
项目步骤默认选择已有项目，只挂载原目录，不复制、清空项目数据库；所选项目保留名称和标识，
注册路径重新映射为 `/data/projects` 或对应子挂载。也可选择新项目根目录、添加额外挂载。
最后可以「仅保存，稍后开启」，或勾选已了解配置与目录变化，确认并重启。已准备环境显示管理页。

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
并从归档配置内容计算、核对 Podman 镜像 ID；兼容带或不带 `sha256:` 前缀的 ID，
缓存与运行配置统一保存带前缀的完整 ID。系统、架构、入口及 ID 校验失败分别提示原因。
成功或失败后均删除临时归档，已有匹配镜像复用，不删除其他镜像。
Docker 原镜像与容器保持不变，启用后的沙箱运行无需 Docker 持续运行。
未配置在线镜像时必须先选择本地镜像；正式发布包仍使用固定在线摘要。
本地导入路径已在 macOS ARM64 使用受管理 Podman 5.6.2 实测：扫描、Docker
归档导出、配置摘要核对、Podman 导入、虚拟机停启、容器健康检查（200 / ok）
和自有资源删除均通过；Windows 与 Linux 的本地导入尚未完成实机验收。
手工 Docker Compose 继续使用 `workstep:latest`。

### 内置浏览器运行时

主 `Dockerfile` 默认在 `node:24-bookworm-slim` 上安装固定版本的
Playwright、Chromium（含 headless shell）、系统依赖和中文字体，不安装完整桌面。
浏览器和驱动放在 `/opt/workstep-browser`，不受沙箱 `/root` 持久化挂载影响。
只维护一个默认带浏览器的应用镜像，不需要预先构建基础镜像或传入运行时参数：

```bash
docker build -t workstep:latest .
docker run --rm --network none --tmpfs /root --entrypoint node \
  --mount type=bind,src="$PWD/scripts/verify-browser-image.cjs",dst=/tmp/verify-browser-image.cjs,readonly \
  workstep:latest /tmp/verify-browser-image.cjs
```

验证会在容器内部启动临时 HTTP 服务，测试网页导航、中文表单、点击、JavaScript
和 PNG 截图，不读取宿主 Home 或凭据，也不访问外网。
需要单独调试浏览器构建阶段时，可使用 `docker build --target browser-runtime`。
容器内 Node 脚本使用
`require('/opt/workstep-browser/node_modules/playwright')`；命令行可直接使用 `playwright`。
这只提供浏览器与脚本运行环境，尚未为各 AI 引擎自动配置浏览器 MCP 或操作工具。

浏览器作为主 Dockerfile 中独立的 `browser-runtime` 构建阶段，不依赖应用源码。
日常修改应用代码时复用浏览器层缓存；全新构建机需下载依赖，可通过构建缓存加速。
现有 Docker Compose 和正式发布流水线直接使用主 Dockerfile，也会默认包含浏览器。
本机重新打包使用同一个 Docker builder 并保留构建缓存，不使用 `--no-cache`，也不清理
仍需复用的 builder 缓存。修改应用代码不会重新执行浏览器安装；升级 Node 基础镜像、
Playwright 版本或修改浏览器安装指令时，才会使对应层失效。
正式发布流水线通过 GHCR 同仓库的 `buildcache` 标签恢复和保存 registry 构建缓存，
使用 `mode=max` 保留中间构建阶段。首次成功发布缓存后，后续全新 CI runner 可复用
浏览器层，只需拉取缓存层。首次运行、缓存不存在或缓存被删除时仍需安装。
构建缓存独立于交付镜像，不会把下载缓存塞进用户镜像；该标签仅供构建使用。
首次构建会下载浏览器和系统包；再次构建命中缓存时不重复安装。
修改浏览器基础环境会使应用运行时层重建，后续应用代码修改不影响浏览器层。

当前 WorkStep 以 root 运行，默认 Playwright 启动不启用 Chromium 自身的 sandbox；
容器隔离与浏览器 sandbox 是两层不同机制。若用于任意外部网站，需进一步验证
非 root 浏览器运行方式和 Podman 权限配置。此试验不要求 privileged、新增 capability
或共享宿主 IPC。高并发页面如出现共享内存不足，可单独调整容器 `/dev/shm` 配额。

2026-10-19 拆分构建的本地 Docker `linux/arm64` 试验记录（合并为单一 Dockerfile
前测得，耗时随网络及机器变化）：

| 项目 | 实测 |
| --- | --- |
| 浏览器基础镜像成功构建 / 缓存重建 | 92.71 秒 / 0.27 秒 |
| 使用浏览器基础镜像的应用首次构建 / 缓存重建 | 187.28 秒 / 0.55 秒 |
| `docker image ls` 显示的普通版 / 浏览器版大小 | 2.07 GB / 3.73 GB |
| 浏览器基础镜像大小（包含 Node） | 2.02 GB |

2026-10-20 已改为单一 Dockerfile：不传运行时参数的完整构建成功，浏览器安装阶段
命中缓存；本机此次应用构建 90.46 秒，缓存重建 0.56 秒，显示磁盘占用约 3.73 GB。
9 项共享镜像检查通过，新镜像在断网、空 Home 下通过网页导航、中文表单、点击、
JavaScript 和 PNG 截图验证。
另在隔离目录实际修改应用源码后重新打包，验证应用 COPY 层重建、浏览器安装层
仍为 `CACHED`，该轮构建耗时 21.67 秒。远端缓存配置通过本地检查，尚未执行真实
CI 发布验证。

首次 HTTP 取包出现 502；加入重试、安装 CA 证书并切换 HTTPS 后成功，上表耗时
不含失败尝试。缓存重建没有修改源码，不代表源码变更后的完整构建时间。
普通版完整构建和已有 8 项共享镜像测试通过；浏览器基础镜像及完整应用镜像均通过
离线浏览器验证。完整应用验证使用原 `workstep-entrypoint` 和空 Home，Chromium
版本为 `156.0.8078.4`。尚未验证 amd64、桌面 Podman 切换及 Codex/MCP 端到端调用。

体积复核：上述 `docker image ls` 数字为本机 containerd 存储的磁盘占用，包含
压缩内容和解压层，不是网络下载大小。容器内浏览器目录约 680 MiB，其中完整
Chromium 401 MiB、headless shell 276 MiB；字体目录约 152 MiB。主要 npm/uv/apt
下载缓存已清理，但原应用构建仍残留约 9 MB Volta 临时安装包，且网关依赖缓存
在后续层才删除，后续可优化；运行时种子归档用于空 Home 离线初始化，不属于缓存。
另已用独立 Home 的长期测试容器启动完整应用，复用现有实例的供应商、模型和引擎
配置（不复制项目、BOT 或网关激活状态），验证 React 页面渲染、健康与引擎接口 200、
无页面 JavaScript 异常，以及浏览器表单操作和截图。不调用付费模型。

`scripts/verify-browser-ui.cjs` 提供实际页面操作与截图报告验证，只在独立测试容器中
执行。它会通过界面创建唯一测试目录和项目、验证刷新恢复、修改外观与语言、检查
390px 移动端布局，并创建空会话填写草稿，不点击发送。输出目录包含 `report.html`
（内嵌全部 PNG，可离线打开）、`results.json` 和逐项截图。每次执行会留下新的测试
项目和空会话；不要对日常实例运行。2026-10-19 本地容器验证 10 项全部通过。

```bash
docker cp scripts/verify-browser-ui.cjs <测试容器>:/tmp/verify-browser-ui.cjs
docker exec <测试容器> node /tmp/verify-browser-ui.cjs /tmp/browser-report
docker cp <测试容器>:/tmp/browser-report ./browser-report
```

## 配置、权限和清理

WorkStep 配置迁移从普通模式的 `~/.workstep/config.json`（设置了 `WORKSTEP_CONFIG_DIR` 时以其为准）
读取，在确认准备后写入沙箱 `home/.workstep/config.json`。供应商（含密钥和选定模型列表）、
模型选择/标准引擎参数/供应商绑定、显示名称/并发限制/Git 扫描深度可以分别选择。
只复制白名单字段，排除项目注册路径、默认项目目录、引擎程序路径、设备标识、远程访问权限、
自定义配置片段及 MCP 本地命令等宿主相关配置；托管供应商由企业网关重新下发。
已有同 ID/同名供应商默认保留沙箱值，并重映射关联的供应商 ID；可明确选择覆盖。
每次写入目标配置前创建私有备份并原子替换，原配置不受影响。包含本机回环地址的供应商
在管理页提示检查，不自动改写地址，不返回密钥。首次复制后两边独立保存，后续可手动导入。
切换不会清空原项目任务或消息；未关联的项目暂不出现在沙箱列表。关闭沙箱并重启可回到普通
模式；沙箱中的编辑会修改已挂载的原项目文件，不应同时在两种环境运行同一项目。

Codex、Claude、共享配置的导入按钮只读取宿主 Home 对应的固定目录；复制前完成
暂存，已有目标移动到备份，失败恢复目标。跳过符号链接、缓存、临时文件和锁文件。
不自动移动宿主引擎二进制，也不盲目改写配置中的绝对路径；必要时重新配置挂载路径。
导入必须在关闭沙箱并重启到非沙箱后进行。

默认容器只挂载 Home 和列出的项目目录。宿主机首选 `8766`，转发到容器内部
`8765`；非沙箱桌面也首选宿主机 `8766`。桌面主进程把宿主机局域网地址和实际
端口通知容器，因此远程访问页不会显示 Podman 虚拟网卡地址。监听端口使用临时桌面
令牌保护；远程访问未开启时外部业务 API 返回 401，开启后再按远程访问密钥校验。
Electron 主进程为本机 daemon 的 HTTP 与 WebSocket 请求自动附加每次启动生成的
桌面令牌，daemon 验证后放行，不依赖平台本机会话的 8 小时有效期。Podman 转发后
即使来源呈现为容器 IP，也不影响令牌校验；容器 IP、Host 或普通桌面标志均不作为
免检凭据。配置网关后，已开启的内网访问仍走访问密钥解锁，网关隧道保留用户、设备
和项目授权检查；桌面本机免平台会话不代表获得平台供应商授权。
不暴露容器管理 socket，不使用 privileged。Codex 等内层沙箱确有兼容需求时，
可显式勾选兼容权限（SYS_ADMIN 和关闭 seccomp）；界面说明隔离强度会降低。
企业桌面的签名网关配置额外以只读方式挂载，宿主路径转换为容器内固定位置。

关闭模式保留 Home 和下载；删除必须先关闭沙箱并重启。删除只针对归属记录匹配的
目录、容器和机器；先移除系统注册，再清理目录，项目保持不动。
Windows 上不要直接删除目录代替清理按钮，否则可能留下 WSL 注册。

## 验证

### Windows 正式包沙箱验收

GitHub Actions 的 `Desktop package smoke` 提供独立的 `sandbox_tag` 输入。
选择验收脚本所在分支作为 `ref`，设置 `sandbox_tag=v1.0.11`，其余验收输入留空，
只运行 Windows 2025 沙箱测试，不构建或修改发布包，也不运行 GitLab CI。
测试下载正式 EXE 和校验清单，安装后提取未修改的沙箱模块，使用真实 Podman、WSL2
与包内固定的 GHCR 镜像完成初始化、挂载、后台鉴权、数据持久化、重启与所属资源清理。
运行器前置条件、通过项、失败阶段和脱敏日志上传到 `windows-sandbox-evidence`。
WSL2／虚拟化不可用或步骤失败均判失败，不能跳过后声称通过。

这项测试不是 Electron 设置界面、原生目录选择器、Windows 10/11 用户机器或真实 LLM
验收，也不覆盖本地 Docker 导入。以实际运行报告为准，新增脚本本身不代表沙箱已通过验收。

2026-10-11 对正式 v1.0.11 的 [中文目录验收](https://github.com/xzregg/workstep/actions/runs/38144390447)
失败：Podman ZIP 下载校验后，系统 `tar` 无法打开中文沙箱目录中的归档，错误路径显示
为 `???? with spaces`，尚未进入 WSL 虚拟机和容器启动。不能宣称 Windows 沙箱通过验收。
可用 `sandbox_ascii_root=true` 做英文存储目录诊断补测；报告明确标记路径范围，
不能用该结果替代中文目录验收或掩盖上述正式包问题。

同日的 [英文沙箱目录诊断](https://github.com/xzregg/workstep/actions/runs/38144788984)
确认正式包内 Podman 6.1.3 的下载校验和解包、真实 WSL2 虚拟机、磁盘归属检查、
匿名 GHCR amd64 镜像拉取、OCI 缓存和缓存复用均通过。项目目录仍使用中文及空格。
沙箱启动阶段随后在健康检查预算内未就绪，报告为 `success: false`，失败阶段
`first-start`；容器日志没有提供可判定根因的输出，不能断言是后台自身失败或端口转发失败。
项目／任务创建、持久化与重启断言均未执行，不计为通过。失败后的所属资源清理没有
报告错误，但不等同于完成整个清理验收场景。两次运行均测试未修改的正式安装包，
SHA-256 为 `eba0d095f6ae38f338e0cd3faa6f1019c50eeae2a1ebe2b3ad6528f0dc1e36e8`，
镜像为 `ghcr.io/xzregg/workstep@sha256:f096c9987be155edd6f2141e5c07d74731ab8bc4bf3fb0d2bee37d2318504856`。
GitHub 证据附件包含报告、运行器前置条件和脱敏生命周期日志；本轮不修改 main、
发布标签、正式附件、GitLab 分支或 GitLab CI。

修复代码复测使用 `sandbox_source=true`：仍安装并验证上述原正式 EXE、使用其固定镜像，
但生命周期调用切换到检出提交的沙箱模块。报告登记提交、模块哈希与这一差异；
它不是修复版安装包验收，不能据此宣称正式发布附件已修复。
[中文目录修复复测](https://github.com/xzregg/workstep/actions/runs/38148639418)
已确认改用 .NET ZIP 解包后，中文沙箱目录中的 Podman 安装、WSL2 和镜像准备通过。
启动前快照显示 Home 位于 Windows `9p` 挂载，内置运行环境还处于 `.base-stage.*`
初始化阶段，容器内后台端口尚未监听；原 90 秒窗口随后超时。Windows 健康检查现改为
最多 5 分钟，其他平台仍为 90 秒，保留超时失败和取消检查。

随后 [完整修复复测](https://github.com/xzregg/workstep/actions/runs/38149415006)
通过，报告 `success: true`、12 项通过，检出提交为
`73ba38bced46b1aaad46b866437b1ff20c898ef3`。真实进程快照确认 `tar` 正在 Windows
`9p` 挂载上解压约 418 MiB 的镜像种子；首次从 `starting` 到 `running` 约 114 秒，
重启约 15 秒。中文存储路径及中文项目路径的初始化、前端与后台版本、宿主端口转发、
鉴权、迁移配置、越界目录拒绝、项目双向文件读写、项目／流程／任务及记忆持久化、
WSL 停机、重启恢复、所属注册和目录清理均通过，原宿主配置及项目数据保留。
桌面 Node 回归 125 项和公开入口回归 13 项通过。
仍未覆盖修复版安装包、Electron 沙箱界面、Windows 10/11 用户机器及系统重启、
付费引擎调用、本地 Docker 导入；原正式 v1.0.11 附件尚未重新构建，不应按新结果视为已修复。

- 桌面 Node 测试覆盖下载校验、路径与符号链接、IPC 来源和目录授权、活动工作保护、失败准备、重启保留、配置导入备份与专属资源清理。
- 分步准备测试覆盖先准备软件/镜像再选择项目、镜像缓存复用与损坏拒绝、未选择项目时的清理、慢运行时操作期间状态查询及并发保护；配置迁移测试覆盖密钥/模型绑定、同名供应商 ID 重映射、路径排除、原配置保留、项目标识与容器路径映射。
- 前端行为测试覆盖明确准备、下载错误重试、切换确认、浏览器隐藏入口；字典测试检查语言键一致。
- 2026-10-06 已在 macOS arm64 实测官方安装包下载、SHA-256、无安装解包、AppleHV 初始化/启停、本地 WorkStep 镜像加载、容器健康及接口鉴权、配置导入、runtime 和项目重启保留、专属资源删除。清理后未发现测试进程，项目文件保留。
- 实测接口：`GET /api/health`、`GET /api/engine/list`、`GET /api/templates/list`、`POST /api/project/init`、`GET /api/project/list` 均为 200；不带桌面令牌的项目列表请求为 401。
- 实测路径：Python 为 `/app/apps/daemon/.venv/bin/python`（3.14.8），Node 为 `/root/.workstep/runtime/base/bin/node`（24.21.0）；npm、uv、git 及容器内 Codex 测试配置读取通过。未使用宿主真实引擎凭据，未调用付费模型。
- 此次修复：Podman 5.6.2 的 machine 命令不支持新版 provider/update-connection 参数，macOS 使用独立配置指定 provider；Fedora CoreOS 共享目标使用 `/var/mnt`，避免 `/mnt` 符号链接使 systemd 挂载失败；已校验镜像种子的 tar 解包保留可信链接目标，避免 rootless virtiofs 无法打开模式 000 的链接占位文件。
- 实测使用本地 `workstep:latest` 加更新后的入口脚本构建的临时镜像，未覆盖正式发布镜像匿名拉取、全量镜像重建、Electron 界面端到端切换、引擎下载及模型执行。Windows/Linux 仍需要各平台实机验证；离线测试不替代实机验收。

完整实机验收应包含空 Home 初始化、CLI/SDK 调用、含空格路径、额外挂载、断网重启、
镜像升级保留数据、关闭应用停止资源、删除后无专属机器注册及现有 Podman 环境不受影响。

### 网关连接状态与重启恢复

侧栏标题下显示网关的实际控制连接状态，可点击进入远程访问设置。开启模式不代表已经上线；需要登录、待审批和连接中分别显示。成功认证并完成握手后，daemon 将网关签发的续连凭据保存在当前 Home 的 `~/.workstep/gateway-connections/`（目录 0700、文件 0600），重启自动重新握手。旧版本未保存凭据时需先在内置窗口认证一次。续连不能恢复旧权限，设备撤销或凭据过期时重新认证；关闭网关模式或更换地址会删除原续连凭据。系统设置中的网关账号由已验证的网关身份提供，只读显示，切回本地模式恢复本地使用者名称。
