# 自定义皮肤接入

## 外观、布局和脚本组件

自定义皮肤支持配色、字体、背景、布局、动画、菜单及脚本组件。向用户统一描述这些能力，不按版本划分，也不要求用户选择格式版本。制作统一使用 `skin.json`（技术字段 `schema_version: 2`），配置包含清单字段及 `tokens/styles/layout/desktop/mobile/menus/effects`；必须生成自包含 ES module `theme.js`，没有脚本功能需求时也必须创建空文件，不得省略。可选 `theme.css` 和 `assets/`（PNG/JPEG/WebP/WOFF2）。不要同时生成 tokens.json/components.json；修改旧包时将其中配置合入 skin.json 并移除旧配置文件。可以编写自由 CSS 和可信前端组件，不修改应用源码、设置选项或安装后端代码。

`layout.composerPosition` 为 top/bottom/left/right，桌面支持左右输入，紧凑界面堆叠。`effects` 可含 reveal:boolean、charsPerSecond:10–1000、maxDurationMs:10–10000。CSS 使用 `[data-ui="workspace/main/navigation/conversation/messages/message/composer/settings"]` 等稳定标识（实际选择器每次填写一个值）；允许普通 CSS、Grid/Flex、过渡、keyframes 和包内 `url("assets/...")`，不接受 @import、外部资源或嵌套选择器。设置仅改样式，不改变选项、分组、顺序和保存逻辑。全窗口背景画布位于 workspace 层时，检查 app-shell 及中间容器的背景和层叠关系；不能先隐藏静态背景，再让不透明容器遮住画布。静态回退和脚本开启均须在手机滚动、视口高度变化后仍可见。覆盖实际 ChatWorkspace 的 chat-workspace-panes、chat-workspace-pane 等中间层及选中阴影；背景验收必须使用完整对话页面并切换会话，不能只渲染 AssistantChatPanel。

`menus` 是 `{id,label,position,items}` 数组，position 为 top/bottom/left/right，items 为 `{label,action,args?}`。内置动作：navigate({path})、settings.open({section})、appearance.open、chat.new、input.set({text})、chat.send、chat.stop、action.run({id})；feature.open({id}) 打开已注册功能。

有脚本功能时，theme.js 导出 `activate(api)`，返回清理函数；无功能时保留空文件，加载时不执行任何操作。`api.React` 提供应用 React，`api.components` 包含 Button/Input/ConfirmDialog；不要打包第二个 React、使用 JSX 源码或导入应用内部模块。`api.features.register({id,title,render})` 注册独立功能，render 接收 `{storage,close,onDirtyChange}`；有未保存表单时通知 onDirtyChange。`api.slots.register({id,title,slot,render})` 添加小组件，slot 为 workspace-top/bottom/left/right、chat-header、composer-before/after。注册函数返回注销函数。

`api.storage(featureId)` 提供异步 get/set/delete/list/export/import，接收 JSON 数据；版本升级保留身份/设备/皮肤/功能隔离的 IndexedDB 数据。显示读写失败；导入会原子替换当前功能数据，操作前用 ConfirmDialog 确认。皮肤导出不包含用户数据。`api.actions.register/execute/enabled` 注册或调用动作；`api.context.get/subscribe` 返回当前聊天上下文；`api.client.request` 复用现有 API；`api.asset(path)` 解析包内资源。事件监听使用 api.signal，计时器在清理函数释放，模块顶层不做副作用。

脚本由设置 → 外观 → 选中皮肤 →「运行皮肤脚本」开关控制；检测到 theme.js 时开关可用，无脚本时禁用并说明。直接切换、立即生效，不弹额外授权确认。选择按当前身份、设备访问范围和皮肤保存，刷新、重新加载及更新同名皮肤后沿用，关闭则立即停用组件。制作窗口和皮肤卡片内的缩略预览不执行脚本。脚本权限与当前页面相同，不要把它描述为沙箱；真实预览中的业务操作不自动撤销。故障恢复使用 URL `skin=default`。可按需在 theme.js 中创建新组件，通过 api.features.register 或 api.slots.register 注册；组件代码随皮肤包提供，本地数据使用 api.storage。使用 skin validate/register/export，校验不执行脚本，不代表视觉验收。

## 制作流程

先阅读对话提供的 Runtime 根目录中的 `skin-contract.json`。会话在该根目录中自行建立皮肤包目录，默认建议使用 `skin/`，也可另行命名；不要覆盖其他已有成果。完整规范可通过 `skin contract --json` 查询。生成 skin.json 和 theme.js，按需生成 theme.css 及本地资源，不修改应用源码。结构化样式、布局及动作以规范为准，更自由的样式和交互使用上述 CSS 与组件接口。部位含引擎展开选项和所有工作台界面，未覆盖部分继承默认。

1. 先询问用户风格、颜色、背景、PC/手机布局及重点控件。用 `skin list --json` 检查同名包，禁止直接覆盖。
2. 在 Runtime 根目录创建或修改选定的皮肤包目录；清单必填 id/name/version/schema_version，schema_version 固定为 2，color_scheme 为 light/dark。默认 ID 不可使用。始终创建 theme.js，无需脚本功能时创建空文件。
3. skin.json 中 tokens 使用规范允许的变量；styles/layout/desktop/mobile 同样放在 skin.json，终端覆盖也可指定 tokens/styles/layout。styles 部位下按状态配置外观属性。背景引用 assets/*.png、*.jpg、*.jpeg、*.webp。
4. 保留字体偏好、手机触控尺寸、焦点、禁用/运行状态。自定义样式使用 theme.css，新增交互使用 theme.js 和公共 SDK；复用应用动作，不复制核心业务逻辑，不引入外部资源。
5. 通过本技能的 Transport 使用 `skin validate /absolute/skin --json`。检查 overridden/inherited，并明确报告尚未视觉验收；不要声称格式检查证明全部页面已通过。
6. 用户已明确要求安装时才用 `skin register /absolute/skin --json`；更新同名包需要用户明确授权覆盖并指定 --replace。注册再次完整校验，不需要重启。
7. 引导用户在设置→外观与皮肤预览 PC 和手机，检查引擎选择器、消息输入、任务、流程、Git、设置与弹窗。关闭设置后可继续预览真实页面，固定栏支持确认、取消和恢复默认。
8. 用户要求分享包时使用 `skin export <id> --output /absolute/name.zip --json`。导出包不含聊天、项目或凭据。

核心业务生命周期和控件事件由应用持有，脚本可以定义新增组件的事件处理器并调用公共动作。引擎切换仍由原有交接确认流程完成；布局尺寸由组件与 CSS 共用，不绕过现有权限和交互约束。


### 字体与字号

同一个外观制作对话可以只调整字体或字号，不必重新选择配色。字体类型写入 `skin.json` 的 `tokens.font-body` / `tokens.font-display`，代码字体使用 `tokens.font-mono`；使用系统字体优先列表并提供后备字体，也可通过 theme.css 使用包内 WOFF2 字体，不引用远程字体。字号写入 `skin.json` 的 `layout.fontSize`，只允许 `small` / `standard` / `large` / `extraLarge` / `inherit`，分别对应现有四档控件或沿用设备设置。不要修改受保护的 `font-scale`。读取最新 Runtime 根目录 `skin-contract.json` 后再生成并校验；未请求的颜色、布局和内容保持不变。

预览仅临时调整字体与字号，取消恢复设备原偏好；确认应用后与外观设置的手动控件同步。此后手动选择的字体和字号优先于皮肤，在刷新后保留。语言包使用独立的 language validate/register 流程，不与皮肤包配置混写。

发送图标使用 `skin.json` 的 `layout.composerSendIcon`：`send`（纸飞机，默认）、`arrow-up`、`arrow-right`。PC／手机可用 `desktop.layout` 和 `mobile.layout` 覆盖。旧皮肤省略时保持纸飞机。停止、处理中、发送和审批动作不受图标配置影响；支持自定义矢量路径对象，例如 `layout.composerSendIcon: {"paths":["M12 3C8 7 8 13 12 17C16 13 16 7 12 3Z","M9 15L6 19M15 15L18 19M12 18V22"]}`，可生成火箭或其他线条图案，无需改 WorkStep 源码。固定 viewBox 为 `0 0 24 24`、无填充、线条随按钮文字颜色。对象只含 paths，1–32 条，每条最多 4096 字符，以 M/m 和坐标开头，仅允许标准路径命令、数字、空格、逗号、小数点和正负号。不能填写完整 SVG XML、属性、脚本或远程 URL。重新读取 Runtime 的 skin-contract.json 和 skin-design.md 获取最新规范，不沿用历史对话中的旧限制。
