# 动态皮肤开发规范（v1）

皮肤入口：设置 → 外观与皮肤。默认皮肤随应用提供；用户皮肤独立注册、ZIP 导入导出。聊天制作沿用普通项目对话，不新增助手协议或聊天通道。

皮肤、引擎、技能制作复用同一个固定 `Runtime` 项目，每次仅新建普通会话，不分配类型或草稿目录。规范在项目根目录；右栏默认读取根目录下的 `skin/`，可指定对话实际创建的其他包目录。已安装库不迁移。目录与生命周期见 [自定义草稿共享工作区](customization-workspace.md)。

聊天制作以 `SkinStudio` 双栏窗口呈现：左侧嵌入既有 `ChatPage`，复用普通会话、`useChatSessionStore`、消息、输入、停止、审批与引擎配置；通过显式项目／会话上下文工作，不切换外层任务路由或活动项目。右侧可微调名称、基础配色、强调色、引擎列表／卡片、导航左右及工具栏位置。微调先保存到对话正在编辑的同一包，发送消息前自动保存；对话结束后重新读取。运行期间禁用微调，版本冲突时拒绝覆盖并提示重新读取。

右侧预览在独立沙箱文档内编译草稿 CSS，分别按 1024px／390px 布局缩放显示，草稿不会改变正在使用的皮肤。关闭未保存的微调需确认；保存皮肤时注册包，再进入全站预览，确认后才应用。

## 权威契约与覆盖

机器规范为 `apps/daemon/data/skins/contract.json`，前端直接导入同一文件；后台校验、CLI、工作区里的 `skin-contract.json` 都读取它。

- `tokens` / `token_kinds` / `value_patterns`：可设置的变量、类型与共享校验表达式；字体缩放、响应断点不可覆盖。
- `parts`：全部生产 CSS 与静态 JSX 样式部位，以及输入、按钮、引擎选择器、图表等语义别名。包含 `::before` / `::after` / 占位符；这些部位只允许改变外观，不开放生成内容。
- `states`：普通、悬停、按下、焦点、禁用、选中、展开、加载、错误、运行、成功、暂停、停止中、空、失败、等待。选择器明确暴露 ARIA 和数据状态；其他部位按契约选择器命中真实状态，不能把不适用的状态声明成已实现。
- `properties`：允许的外观属性。位置、显示/隐藏、层级、指针行为、事件、任意 CSS 和 JavaScript 均不属于包接口。拖柄 padding/borderWidth 不可改，尺寸使用布局配置。
- `components`：核心组合模块的部位、状态、动作、必留内容和可选呈现。
- `actions`：应用持有的动作契约；皮肤只选择应用提供的结构，不定义处理器。

未覆盖项继承默认样式。校验报告 `coverage.overridden` 和 `coverage.inherited` 按部位统计，不代表每个页面、每种状态均经过视觉验收。`visual_checked` 固定为 false；后台格式校验不能代替真实渲染检查。

新增 CSS 或 JSX 部位后运行 `python scripts/update-skin-contract.py`；验收运行 `python scripts/update-skin-contract.py --check`。v1 已登记的部位不因移动文件自动删除。更换部位语义或删除公共部位时必须迁移兼容接口或增加规范版本。

## 包结构

```text
skin/
  skin.json
  tokens.json          # 可省略，缺省为空
  components.json      # 可省略，缺省为空
  assets/              # 可省略；PNG / JPEG / WebP
```

清单示例：

```json
{"id":"ocean","name":"海洋","version":"1.0.0","schema_version":1,"color_scheme":"dark"}
```

ID 使用小写字母开头，可包含小写字母、数字、`_`、`-`，最长 64 字符；`default` 保留。版本和名称必填，描述可选。`color_scheme` 为 light 或 dark，未填按 light 处理。首版不开放包脚本、远程资源、字体文件或 SVG 图片。

`tokens.json` 示例：

```json
{"bg":"#101923","surface":"#182838","fg":"#eaf2fa","accent":"#56b8ff","accent-fg":"#102030"}
```

优先使用十六进制或 RGB 颜色；其他类型以共享表达式为准。字号保留 `var(--font-scale)` 可继续遵守使用者的字体偏好。全局变量只覆盖自身，不自动推导其他颜色；制作深色皮肤时同时调整正文、次要文字、边框、语义状态和表面背景。完整可运行示例在 `apps/daemon/data/skins/example/`。

`components.json` 示例：

```json
{
  "styles": {
    "engine-select-trigger": {"base":{"borderRadius":"12px"}},
    "skin-select-option": {"selected":{"backgroundColor":"#183b58"}},
    "app-shell": {"base":{"backgroundImage":"assets/background.webp","backgroundSize":"cover"}}
  },
  "layout":{"sidebarSide":"right","sidebarWidth":280,"stepsSide":"right","engineAppearance":"cards"},
  "mobile":{"layout":{"sidebarSide":"left","engineAppearance":"list"},"styles":{"chat-input-frame":{"base":{"borderRadius":"12px"}}}},
  "desktop":{"tokens":{"accent":"#56b8ff"}}
}
```

所有层级的未知字段、未知部位、未知状态、未知属性及 CSS 注入均应拒绝；PC/手机覆盖允许 `tokens`、`styles`、`layout`。资源文件名使用英文字母、数字、`_`、`-`、`.` 及目录分隔符；图片必须存在于包中且类型匹配。单文件最多 8MiB、总计 32MiB、最多 256 文件；不接受符号链接、ZIP 越界路径或可执行文件。

## 布局与事件边界

| 布局字段 | 支持值 / 范围 |
|---|---|
| sidebarSide / sidebarWidth | left、right / 180–480px |
| contentWidth | 640–2560px 的最大内容宽度 |
| density | standard、compact、comfortable；调节任务卡片密度 |
| stepsSide / stepsRatio | left、right / 0.15–0.85，比例始终指步骤区域 |
| splitHandleWidth | 4–16px，CSS 与拖动计算共用 |
| composerToolsPosition | top、bottom，移动工具栏但保留各动作 |
| engineAppearance | list、cards，保留原引擎可用性和切换流程 |

布局优先级：默认 → 包公共布局 → 当前终端覆盖。PC ≥1024px，手机/紧凑布局 ≤1023px。用户实际拖动宽度/比例优先于皮肤默认值；切换布局仍保留用户结果。

所有应用渲染的选择器在自定义皮肤下使用公共选择器；默认皮肤保留原生选择器外观。引擎分组、不可用原因、当前值、键盘导航、搜索和焦点恢复归应用持有。原有原生 change 语义仍通过公共组件交回业务调用方，包括引擎交接确认和取消回流。浏览器控制的文件选择器、原生日期/系统窗口不属于可换肤 DOM。

发送/停止/上传/审批/保存/删除、快捷命令、权限、分享只读规则、API 与 WebSocket 不由皮肤接管。不复制聊天实现，也不新增业务事件总线。皮肤只能调整已提供的部位顺序与布局选项；任意模板和可执行组件属于另一个插件级扩展。

项目授权界面继续使用 `useGatewayProjectPermissions` / `ProjectPermissionGate` 的具体动作权限；自定义皮肤不能恢复未渲染的入口或绕过路由限制。项目范围工作台不开放全局设置；皮肤注册、目录校验、ZIP 管理和聊天工作区创建仍是宿主操作，项目读者与编辑者均不能管理宿主皮肤。

运行时通知：

- `workstep:skin-change`：DOM 样式和布局已应用，包含 id、revision、layout、reason；窗口跨越断点时 reason 为 viewport。
- `workstep:skin-lifecycle`：type 为 load、preview、apply、cancel-preview、restore、error，包含 id、revision，错误时包含 error。

皮肤包不订阅这些事件。应用组件使用通知结束当前拖动、关闭需要重新定位的选项菜单；业务会话、输入草稿和连接不重新挂载。日期控件与 Mermaid 使用同一主题；Mermaid 保留稳定内容/流式结束后动态渲染和缓存，皮肤颜色加入缓存依据。

## 注册、预览和存储

宿主安装目录为 `$WORKSTEP_CONFIG_DIR/runtime/skins/<id>`（原子注册索引文件）；完整不可变包位于 `runtime/skin-assets/<sha256>/`，旧版本保留供已打开终端读取。校验可创建预览快照，不改变注册索引。注册再次校验当前完整包，更新同名包必须指定 replace。

当前选择保存在浏览器 origin 和网关设备路径对应的 `workstep.skin.v1:<workspace-path>` 中，终端之间不自动同步。启动先应用已缓存的完整包，避免界面闪动；包更新后通过列表重新应用新版本。关闭设置后预览继续生效，可通过固定恢复栏确认或取消。

任何自定义包都不能覆盖固定恢复栏。加载损坏缓存时恢复默认；启动 URL 增加 `?skin=default` 可强制恢复并保存默认选择。默认皮肤不可注册覆盖、删除或导出。

## API 与 CLI

读接口为 GET `/api/skins`、`/api/skins/contract`、`/api/skins/{id}`、`/api/skins/assets/{revision}/{name}`。项目范围读取必须携带匹配的 project_id，网关桥接仅开放这些读取。

宿主管理：POST `/api/skins/validate`、`register`、`import`、`export`、`onboarding`，GET `/{id}/export`，DELETE `/{id}`。管理权限沿用宿主安装许可；项目分享不能管理。import 发送 application/zip 原始正文，同名包返回 409，明确 replace=true 后才能更新。

右侧微调使用宿主 POST `/api/skins/draft`，携带 path、expected_revision 与完整 skin 文档；保留原部位和资源，完整校验后更新三个 JSON 文件，不注册、不应用。版本过期返回 409。与 CLI `skin validate/register` 共用包格式及文件目录。

```bash
workstep skin list --json
workstep skin contract --json
workstep skin validate /absolute/skin --json
workstep skin register /absolute/skin --json
workstep skin register /absolute/skin --replace --json
workstep skin export ocean --output /absolute/ocean.zip --json
workstep skin delete ocean --json
```

CLI 与引擎注入工具复用同一 REST 服务；工具 mutation 继续要求明确指令和 confirm。聊天制作会复制规范、复用 Runtime 项目并创建普通聊天会话，注册后用户在设置选择预览/应用，无需重启。

## 验收

- 后台：`test_skins.py`、`test_skin_onboarding.py`、`test_skin_cli.py`；覆盖真实 API、真实数据库慢 SQL canary、慢磁盘健康检查、注册回滚、ZIP、资源和项目鉴权。
- 前端：`skins.test.ts`、`skinSelect.test.tsx`、`skinSettings.test.tsx`、`taskDetailSplitLayout.test.tsx`；覆盖编译、状态保持、继承、预览、真实 change、嵌套浮层 Esc 和布局计算。
- 权限整合：`gatewayWorkspaceApp.test.tsx` 对默认与自定义皮肤分别验证项目只读／任务创建者的入口和路由限制；`test_skins.py` 对项目读者与编辑者逐项检查宿主管理接口拒绝访问。
- 双栏制作：`embeddedProjectChat.test.tsx` 验证项目隔离，`skinStudio.test.tsx` 验证微调写回、预览隔离、关闭保护和运行态禁用；`scripts/check-skin-studio.cjs` 对实际构建做四档宽度浏览器验收。
- 浏览器：先运行 Web build，再执行 `apps/web/scripts/check-skins.cjs`（PLAYWRIGHT_MODULE 可指定现有安装）。脚本读取实际生产构建，全拦截 API/资源，不启动项目服务；检查五档宽度、选项触控尺寸、焦点/关闭及恢复，并保存真实截图到 node_modules/.tmp/skin-qa。这些是验收截图，不代替官网手册演示截图。
- 合并交付时集中同步官网操作手册和真实手册截图；功能分支阶段不宣称手册完成。
