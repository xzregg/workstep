# 开发指南

## 从功能找到代码

先看[功能代码地图](code-map.md)，再在职责所有者内查调用链和测试。页面负责组装，领域 API 放入 `apps/web/src/api/` 的对应模块；后端路由、服务、schema、模型分别放在 `apps/daemon/api/`、`services/`、`schemas/`、`models/`。`src/api/client.ts` 兼容已有导出，不作为新领域逻辑的默认入口。

新增功能或移动职责时，必须同步更新 Code Map 的功能描述和入口，明确测试位置。前端固定样式使用有语义的 class 或 id 写入 CSS；只有运行时计算的值可用 JSX `style`，且只保留动态属性。优先复用现有控件的尺寸和视觉规则。

文件超过 800 行、局部状态超过 15 个或 effect 超过 10 个提示检查职责，但不要求拆到固定行数以下。按独立行为和数据边界抽模块，让模块自己管理请求、校验、错误与关闭保护；不要只把 JSX 搬走，再从页面透传一组 state/setter。重复实现出现两次时优先复用现有组件或领域服务。

## 后端 I/O 与并发

`async def` 中的文件、目录、网络、数据库、同步 SDK 和子进程 I/O 都不能直接阻塞事件循环。优先原生异步 API；没有时把**完整同步工作单元**交给 `asyncio.to_thread` 或专用执行器，包括路径检查、文件打开/关闭、迭代、事务和序列化。Peewee 项目数据库工作单元统一用 `project_manager.run_db(project_id, operation)`；不要让惰性查询或数据库上下文跨越 `await`。子进程 stdout 使用 `engines/core/stream_lines.py` 分块读取。

修改 I/O 路径时写慢盘、慢 SQL、网络延迟或锁竞争回归，并在慢操作进行时测轻量协程或健康检查是否及时响应。静态搜索只能辅助定位，不能代替真实调用路径测试。详细约束见 [`AGENTS.md`](../AGENTS.md)。

## 前端控件与样式

优先用 `Button`、`Input`、`Select`、`Textarea`、`ChatInput`、`ConfirmDialog` 等共享组件，设计规则见[前端设计文档](frontend-design.md)。移动端普通可见控件统一为 32px，高点击区域和菜单项用 44px；使用 `src/mobile.css` 的 `--mobile-control-*` 变量，不在页面样式写一次性高度。消息操作按钮保持紧凑；图标按钮要有明确内边距。新增文案先写 `zh-CN.ts`，所有词典键集合保持一致且非空。

组件新增请求前检查页面、父级和 store 是否已有同一请求；合并重叠 effect 或复用去重的 store action。行为测试跟随拥有状态和请求的组件，页面测试组装。

## 任务详情的模块边界

任务详情与分享页共用 `TaskDetailPage`、`TaskDetailReadCapabilities`。消息归并、排序和最新消息索引由 `components/taskConversationFeed.ts` 持有，未读、跟随、历史分页和内容尺寸变化由 `hooks/useTaskConversationScroll.ts` 管理；通用滚动规则位于 `utils/conversationScroll.ts`。请求、错误和交互跟随实际职责所有者测试，页面只验证组装。

后续拆分消息卡片、审核或编辑器时，应先缩小稳定输入和回调，不透传整组页面 state/setter，也不把历史设计草图当成已实现接口。流程恢复的数据库工作单元及事件循环职责见[恢复线程边界](workflow-engine-execution.md#恢复决策的线程边界)。

## Git 管理的现行边界

生产 Git 工作区使用真实仓库，开发 `/prototype/git` 页面只使用模拟数据，不进入生产构建。项目头部入口复用 `ProjectGitButton`；点击分支浏览，显式切换才改变工作目录。工作区、提交草稿和选择按目录保存，文件对比打开独立弹窗，不把 Git 业务状态放进页面布局层。

### 仓库发现与设置

`git_scan_depth` 是全局设置，默认 5；项目根为第 0 层。扫描只从已注册的本地项目开始，在限深范围识别 `.git` 目录或文件，按规范化 Git common directory 去重，并加入 Git 登记的外置 Worktree。发现嵌套仓库后继续按深度扫描；不进入 `.git`、`.workstep`、`node_modules`、`.venv`，不跟随子目录符号链接，不隐式 prune。

扫描异步、有界执行；配置及项目列表变化后刷新，旧代次不能覆盖新结果。不可访问目录独立报告，不让一个失败中断其它项目。文件 I/O 进入执行器，Git 使用受控异步子进程；同仓库写操作按 common directory 串行化，读取可并行。

### 文件审阅与提交

默认勾选已跟踪修改及已有暂存内容，新文件由用户明确选择。提交单位是所选文件的完整当前内容，重命名包含新旧路径，不提供按 hunk 提交。提交前检查 HEAD、状态和审阅快照；文件再次变化时重新审阅。

后端用字面 pathspec、参数数组及 NUL 分隔文件列表处理特殊或大量路径，说明通过 UTF-8 文件传递。只暂存及提交所选路径，未选文件和既有暂存保持原状；保留 hooks、签名与身份检查。失败保留说明和选择，刷新真实状态，不隐式 reset；已有新提交时先核实 HEAD 再决定是否重试。

差异提供行号、hunk、作者及日期，新增行不伪造历史归属。二进制、无 HEAD、删除文件及大文件有明确降级；当前文本预览上限为 2 MiB、差异 20,000 行，历史分页每页 50 条。历史内容只读，不能混入待提交选择。

### 分支、远程与合并

分支状态来自本地缓存；只有用户显式刷新远程时 fetch，并记录获取时间。切换、创建、删除、合并、恢复和远程写操作由服务验证目录权限、分支/HEAD、审阅快照、进行中的 Git 操作及活动任务，不信任客户端传入的任意 cwd 或参数。被其它 Worktree 检出的分支提供定位入口。

Pull 检查真实远程和本地状态并只允许快进，不自动 stash、rebase 或强制覆盖。Push 指定目标远程与分支，保留 hooks，关闭 mirror、强制推送、自动标签及递归子模块推送；非快进由 Git 拒绝。

普通合并发生冲突时自动中止；合并到未检出目标可使用临时 Worktree。三栏文本冲突预览及解决接口尚未实现，继续由[冲突解决计划](../plans/git-merge-conflict-resolution.md)管理，不能写成现行能力。共享任务仅获得任务限定的 Git 能力，不能使用宿主全局设置和任意仓库写操作。

前端重复读取由 Git store/API 合并；页面隐藏时暂停状态轮询，操作后及恢复可见时统一刷新。实现入口为 `api/git.py`、`services/git/` 和 Web `components/git/`；职责及测试详见[Code Map](code-map.md)。关键回归包括 daemon `test_git_api.py`、`test_remote_git.py`，Web `gitPanelWrites.integration.test.tsx`、`gitDiffDialog.test.tsx`、`gitBranchPicker.test.tsx`、`gitWorkspaceScope.test.ts`。

## 新手引导

`OnboardingChecklist` 与工作区引导动作复用已有表单，引导按真实资源状态推进：供应商、兼容引擎、项目、示例流程和首个任务。状态存于 `workstep:onboarding:v1`，重新打开时核验资源，资源删除后回退；首任务创建即完成，不自动运行或调用模型。升级用户不自动弹出，引导可跳过、收起和从设置 → 系统设置 → 新手引导重新打开；入口和测试见[Code Map](code-map.md)。

## 环境与验证

```bash
cd apps/daemon
uv sync --dev
uv run --no-sync pytest
```

```bash
cd apps/web
corepack yarn install --frozen-lockfile
corepack yarn test
corepack yarn build
```

官网在 `apps/landing`，也使用 Yarn。仓库检查可运行 `python scripts/check_repository_health.py`。行为变更先写失败回归，再实现和验证；跨层变更还需运行相关 API、组件和端到端检查。不要提交构建产物、数据库、日志、密钥或个人配置。

从设置页安装的可选引擎 SDK 位于 `~/.workstep/runtime/python-packages`（或 `WORKSTEP_ENGINE_PACKAGE_DIR`），不在 uv 管理的环境和 `uv.lock` 中；daemon 启动时将该目录加入导入路径。重新同步锁定依赖可运行 `uv sync --dev`，所选 SDK 版本不会因此被覆盖。

外部贡献流程见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

## 用户操作手册

操作手册同步只在 `dev` 合并到本地 `main` 并提交本批代码时触发，集中整理本批已通过行为测试的用户可见功能；日常开发不逐功能更新手册和截图。手册变更随本批交付一起提交。统一维护官网的 [操作手册内容](../apps/landing/src/manual/)。每个功能包含用途、界面入口、操作步骤、输入示例、预期结果、排错说明及真实截图；操作或界面变化时同时修改文字和图片，删除功能时移除失效说明。SDK 是首次接入推荐路径，CLI 保留为其他接入方式。

截图统一复用本机 `8777` 端口的“操作手册演示”项目，启动和目录约定见 [演示环境](manual-demo.md)，禁止包含密钥、个人会话、内部服务地址及私有项目内容。截图声明和图片文件通过 `yarn --cwd apps/landing manual:check` 核对；缺口必须明确登记，不能把示意图当成真实截图。合并提交节点运行官网测试与构建，人工核对桌面、手机端章节导航和图片可读性。详见 [Agent 规范](../AGENTS.md)。

## 应用版本号

桌面端与 daemon 使用同一应用版本，发布版本来源为 `apps/desktop/package.json` 的 `version`。升版本使用 `npm version <版本号> --no-git-tag-version`（在 `apps/desktop` 执行），其 `postversion` 自动同步 daemon 的 `pyproject.toml` 和 `uv.lock`；手动修改版本后执行 `node scripts/sync-app-version.cjs`。

源码 daemon 从桌面端 manifest 读取版本；独立 daemon 目录使用自身 `pyproject.toml`。桌面后端打包时写入 `app/daemon/app-version.json`，版本来自 `WORKSTEP_BUILD_VERSION` 或桌面 manifest。启动器可通过 `WORKSTEP_VERSION` 覆盖运行时版本，网关心跳使用同一运行时值。不得按网关最新发布版本推断本地运行版本。
