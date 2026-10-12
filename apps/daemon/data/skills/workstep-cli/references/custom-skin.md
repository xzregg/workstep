# 自定义皮肤接入

先阅读对话提供的Runtime 根目录中的 `skin-contract.json`。会话在该根目录中自行建立皮肤包目录，默认建议使用 `skin/`，也可另行命名；不要覆盖其他已有成果。完整规范可通过 `skin contract --json` 查询；只生成 skin.json、tokens.json、components.json 和 assets 本地图片，不修改应用源码。首版允许的全部部位、状态、属性、布局及动作均以规范为准。部位含引擎展开选项和所有工作台界面，未覆盖部分继承默认。

1. 先询问用户风格、颜色、背景、PC/手机布局及重点控件。用 `skin list --json` 检查同名包，禁止直接覆盖。
2. 在 Runtime 根目录创建或修改选定的皮肤包目录；清单必填 id/name/version/schema_version=1，color_scheme 为 light/dark。默认 ID 不可使用。
3. tokens 只用规范允许的变量；components 允许 styles/layout/desktop/mobile，终端覆盖也可指定 tokens/styles/layout。style 部位下按状态配置外观属性。背景引用 assets/*.png、*.jpg、*.jpeg、*.webp。
4. 保留字体偏好、手机触控尺寸、焦点、禁用/运行状态。没有声明的部位或结构先说明缺口，不写脚本、任意 CSS、外部 URL 或复制事件逻辑。
5. 通过本技能的 Transport 使用 `skin validate /absolute/skin --json`。检查 overridden/inherited，并明确报告尚未视觉验收；不要声称格式检查证明全部页面已通过。
6. 用户已明确要求安装时才用 `skin register /absolute/skin --json`；更新同名包需要用户明确授权覆盖并指定 --replace。注册再次完整校验，不需要重启。
7. 引导用户在设置→外观与皮肤预览 PC 和手机，检查引擎选择器、消息输入、任务、流程、Git、设置与弹窗。关闭设置后可继续预览真实页面，固定栏支持确认、取消和恢复默认。
8. 用户要求分享包时使用 `skin export <id> --output /absolute/name.zip --json`。导出包不含聊天、项目或凭据。

生命周期和控件事件属于应用，包不能定义处理器。引擎切换仍由原有交接确认流程完成；布局尺寸由组件与 CSS 共用，禁止修改指针/层级/显示规则来绕过约束。
