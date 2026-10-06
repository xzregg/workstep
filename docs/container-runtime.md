# 容器 Home 与运行时持久化

Dockerfile 支持将用户选择的沙箱目录下的 `home/` 整体挂载为 `/root`。
不使用宿主机的真实 Home；项目目录单独挂载到 `/data/projects`。

```text
沙箱目录/
├─ podman/                    后续桌面端管理的 Podman 与虚拟机，不能挂进容器
├─ desktop/                   后续桌面端管理配置与日志
└─ home/                      挂载到容器 /root
   ├─ .workstep/
   │  └─ runtime/
   │     ├─ base/             镜像管理的 Python、Node、npm、uv 与 Git
   │     ├─ volta/            Volta 工具、下载的 Node 与用户配置
   │     ├─ npm/              应用内安装的 npm 引擎
   │     └─ python-packages/  应用内安装的 Python SDK
   ├─ .codex/
   ├─ .claude/
   ├─ .agents/
   ├─ .cache/uv/
   └─ .npm/                   npm 缓存
```

`podman/`、`desktop/` 是桌面沙箱功能的约定，目前仅实现镜像端的 Home
初始化与运行时持久化，尚未实现桌面下载、挂载列表或配置导入界面。
项目的 `.workstep/workstep.db`、事件日志和产物仍在项目目录内。

桌面非沙箱模式默认使用宿主机 `~/.workstep/runtime/`，受管理 npm CLI、Python SDK
和 uv 下载的解释器与此处采用相同的相对目录。桌面 daemon 的基础 Python 随安装包
分发，容器的基础 Python 则由镜像初始化到 `runtime/base/python`；两者不共享二进制。
引擎自身的 `.codex`、`.claude` 等配置仍位于各自 Home 下。

## 镜像启动

镜像将基础运行时打包在 `/usr/local/share/workstep-runtime/base.tar`，
入口 `/usr/local/bin/workstep-entrypoint` 不依赖 Home 里的 Python 或 Node：

构建时将 Python 的 terminfo 数据转换为 ncurses 支持的十六进制目录，
避免 macOS/Windows 大小写不敏感挂载目录中的文件名冲突。

1. 获取 Home 内的初始化锁；目录可以为空，也可以已有引擎配置。
2. 对比镜像安装包摘要与 `runtime/base/.image-sha256`；相同时复用当前环境。
3. 首次初始化或镜像基础运行时变化时，校验摘要并在 Home 内解包到临时目录，
   成功后替换 `base/`。中断后可以恢复上一份基础运行时。
4. 更新 Volta 自身的可执行文件，保留其下载目录和用户配置。
5. 使用镜像构建时锁定的 daemon 虚拟环境执行命令，不在启动时重新解析依赖。

`base/` 由镜像管理，镜像更新时可能替换；用户安装的引擎和包应放在同级的
`npm/`、`python-packages/` 或 `volta/`，不能写入 `base/`。
镜像更新不覆盖 `.codex`、`.claude`、WorkStep 配置和这些用户安装目录。
宿主与容器只共享数据文件，Windows/macOS 的原生 Python/Node 环境不能直接
作为容器的 Linux 运行时。不要让不同镜像版本的运行中容器共享一个 Home。

## 挂载方式

以下片段展示新的挂载结构，宿主目录须提前创建：

```yaml
services:
  workstep:
    image: workstep:latest
    ports:
      - "127.0.0.1:8755:8765"
    volumes:
      - ./data/home:/root
      - ${WORKSTEP_PROJECTS_DIR:-./data/projects}:/data/projects
```

仓库的 `docker-compose.yaml` 已使用整体 Home 挂载，但不会自动迁移现有数据。
采用新结构时，需要把旧的 `data/workstep`、`data/engines/codex`、
`data/engines/claude`、`data/engines/agents` 分别迁移到新 Home 的
`.workstep`、`.codex`、`.claude`、`.agents`；旧 `data/engines/npm`
与 `data/engines/python` 分别迁移到 `.workstep/runtime/npm` 与
`.workstep/runtime/python-packages`。迁移应在原容器停止并完成备份后进行。
旧 npm 可执行文件若引用旧绝对路径，需要在新环境重新安装。

重启、删除并重建容器时，使用相同的两个挂载即可保留 Home 和项目数据。
`apt install` 等写入 Home 外的系统安装不在持久化保证内；此类依赖应加入镜像。

## 验证

`scripts/tests/test_container_entrypoint.py` 使用 Linux 的真实 `flock`、`tar`
和子进程验证空 Home、复用、更新保留用户数据、损坏安装包、中断恢复及锁竞争。
可在具备 Python 的 Linux 环境运行：

```bash
python -m unittest discover -s scripts/tests -p test_container_entrypoint.py
```

镜像检查还需在空 Home 挂载下验证 Python、Node、npm、uv、Volta、Git 和 daemon
模块导入，并以相同 Home 重建容器确认数据保留。此检查无需启动常驻服务。
