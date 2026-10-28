# WorkStep 产品介绍页（apps/landing）

独立的 Vite + React 落地页，用于向独立开发者 / 小团队介绍 WorkStep。与产品 UI
（`apps/web`）解耦。新版沿用软件的纯白底、浅灰分区与蓝色控件，使用轻量流线背景，
支持日间 / 夜间模式及统一登记的 26 种语言。

## 开发命令

使用 Node 22.12+（Volta 固定 22.22.2）与 Yarn 1.22.22；官网新版本构建工具不再支持 Node 20。GitHub Pages 与 CI 使用 Node 22，不影响 Web 应用自己的运行时配置。

```bash
corepack yarn install --frozen-lockfile
corepack yarn dev        # http://localhost:5174
corepack yarn test       # vitest：i18n 键集一致性 + 时间轴工具
corepack yarn lint       # oxlint
corepack yarn build      # tsc -b + vite build，产物在 dist/
```

`corepack yarn build` 会把脚本、样式和品牌图标内联到 `dist/index.html`。构建完成后可直接双击
该文件离线预览，不需要本地服务器，也不会触发 `file://` 跨域限制。

生产模式下 Daemon 会托管官网与 Web 应用：`./start.sh 8765 prod` 会同时构建
`apps/landing`（→ `http://<host>:8765/landing`，构建时使用
`LANDING_BASE=/landing/` 使静态资源位于 `/landing` 子路径）与 `apps/web`
（→ `http://<host>:8765/`，保持 home 不变）。

## 页面结构

- 首屏 Hero：精简双栏介绍，移除装饰卡片及英文标签，配有可暂停、遵循减少动态效果偏好的淡色流线背景；保留引擎安装、认证和模型费用说明。
- 真实录屏（GuidedWalkthrough）：保留原始视频、四个章节、播放 / 暂停与进度跳转。
- 开发任务示例（Philosophy）：用“给项目加一个搜索功能”解释步骤与预期交付内容，属于流程设计示例。
- 操作演示（Demos）：三个动画共用选项卡与播放器；切换后播放，也可暂停、重播、拖动进度或放大查看。
- 六步入门（GettingStarted）：从界面安装一个 SDK 引擎开始，依次完成认证、默认执行配置、接入项目、流程和任务；直接复用完整手册的译文与真实截图。
- 演示之后介绍具体收益、可选引擎、流程扩展示例与工具路线，再展开渠道和远程协作。
- 顶部保留语言、日夜切换、文档、GitHub 与下载入口；「下载」直接打开 GitHub 最新发布页。
- 页脚保留使用条款、隐私、开源许可与支持邮箱；不宣传免费或保证未来零费用。
- 首屏与页尾主按钮：Daemon 内置 `/landing` 官网显示「打开工作台」并返回 `/`；独立官网显示「下载桌面版」并打开最新发布页，支持尚未安装的首次访问者。

## 常见自定义

- 下载链接：`src/config/downloads.ts` 使用 GitHub Releases 的稳定资产名；修改平台产物名时，必须同步更新 Electron Builder 配置和下载测试。
- 演示内容：新增演示时在 `src/demo/demos.tsx` 注册 `DemoDef`，在
  `src/scenes/` 下新增场景组件（纯函数 `{ time: number } => UI`），并同步补充
  `src/i18n/zh-CN.ts` 与 `src/i18n/en-US.ts` 文案。
- 文案：新增展示文案须同步 `src/i18n/index.tsx` 登记的全部语言。主词典由 `tests/i18n.test.ts` 检查；教程标题和隐私补充文案在 `editorial.ts`，法律正文在 `legal.ts`，通过对应页面测试验证。

## 用户操作手册

顶部“文档”进入 `#docs`，章节链接为 `#docs/<chapter-id>`。内容位于 `src/manual/onboarding.ts`（SDK 优先入门）与 `features.ts`（功能操作），页面复用官网主题和导航，提供章节搜索、前后章及原图查看。正文、分类、搜索和图片说明支持全部 26 种官网语言；真实截图保留原界面语言并显示说明。

真实截图存于 `src/manual/screenshots/<screenshot-id>.jpg`，构建通过 Vite 导入，发布目录中的图片需与 HTML 一起保留。本地离线打开也需保留 `assets/` 图片目录。仅在 `dev` 合并到本地 `main` 并提交本批代码时，集中更新本批已验证功能的章节和截图，并运行 `yarn manual:check` 检查覆盖（缺图返回非零）、测试和构建；日常开发不逐功能触发。截图统一复用本机 `8777` 端口的“操作手册演示”项目，见 [演示环境](../../docs/manual-demo.md)。发布时复核已合并版本的手册。截图不得包含密钥、私人对话或内部地址。

## 旧版备份与发布

[旧版官网备份](../../ui/DESIGN/landing-legacy-2026-10-28.zip) 基于 `09377f50`，包含可打开的 `site/index.html`、视频和截图资源，以及 `source/` 可重建源码。保留改版前布局，但按本次要求同步清除免费宣传并采用匿名多语言条款。解压后须保留 `site/assets/`。

新版源码继续维护在本目录。推送 `main` 后，`.github/workflows/pages.yml` 构建并部署到 [GitHub Pages](https://xzregg.github.io/workstep/)；发布使用 `LANDING_BASE=/workstep/`。
