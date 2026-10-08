# 手册演示环境

操作手册截图固定使用 `http://127.0.0.1:8777`，项目名称为“操作手册演示”，本机身份为“演示用户”。该环境只放模拟内容，不复制日常配置、认证、聊天记录或真实项目。

- 独立配置目录：`~/.workstep-manual-demo/config`。
- 固定项目目录：`~/.workstep-manual-demo/projects/storage-demo`。
- 统一存储模式的数据位于演示配置目录的 `projects/<项目ID>/`，沿用项目身份文件。

先在仓库运行 `yarn --cwd apps/web build`，再启动：

```bash
mkdir -p "$HOME/.workstep-manual-demo/config" "$HOME/.workstep-manual-demo/projects/storage-demo"
cd apps/daemon
WORKSTEP_CONFIG_DIR="$HOME/.workstep-manual-demo/config" WORKSTEP_PORT=8777 \
  uv run --no-sync uvicorn main:app --host 127.0.0.1 --port 8777
```

打开该地址；首次进入时使用“演示用户”，点击“直接进入”，通过“添加项目”登记固定项目目录并命名“操作手册演示”。之后复用已有项目和配置，避免每次创建不同项目。服务直接提供构建后的 Web 页面，无需额外前端端口。

启动前确认 `8777` 未被其他服务占用；已存在演示服务时直接复用，不停止未知进程。更新后只重启这套演示服务。手册截图保存到 `apps/landing/src/manual/screenshots/`，文件名采用章节声明的截图 ID；截图前检查只显示模拟内容。
