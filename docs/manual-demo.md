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


## 原型编辑模拟测试与截图

在上述固定演示服务运行、Web 构建完成后执行：

```bash
cd apps/web
node scripts/test-prototype-manual.mjs
```

脚本只接受固定路径且名为“操作手册演示”的项目，将仓库 `scripts/fixtures/prototype-manual/`
的三个样例文件复制到该项目的 `prototype-editor-demo/`，重复运行会重置这三个演示文件。
它使用真实界面与文件 API 验证同名元素精确修改、文字／尺寸回写、删除／撤销、切换页面、
分隔栏和窗口缩放。聊天请求在浏览器内模拟连接失败，检查选中元素信息和重试草稿，不调用模型。
截图在发送前保存为官网 `prototype-editor.jpg`，只展示真实界面与未发送草稿。

助手持久会话、停止、冲突、多文件部分回写恢复通过 daemon 的 `test_prototype_*.py` 假引擎测试验证，
不把它们当作真实供应商或 Electron 安装包验收。此脚本使用桌面工程已有的 Playwright 和本机 Chrome。
