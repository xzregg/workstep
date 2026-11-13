# WorkStep 统一设计规范

> 适用：工作台 Web/桌面/移动端、官网、平台后台。2026-11-13 整合。
> 本文件是设计规范唯一入口；开发交互和工程约束见 [AGENTS.md](AGENTS.md)，功能与测试定位见 [Code Map](docs/code-map.md)。

## 1. 适用范围与权威来源

| 表面 | 采用规范 | 实现基准 |
|---|---|---|
| 工作台：任务、流程、对话、设置及移动布局 | 第 2–10 章 | `apps/web/src/components/`、`index.css`、`mobile.css` |
| 官网与营销展示 | 第 11 章 | `apps/landing` 的生产组件与样式 |
| 平台管理后台 | 第 12 章 | `apps/gateway-web` 与共享 `packages/gateway-ui` |

- 品牌共用中性色、语义色和克制的层级；产品控件不能照搬官网大标题、大间距和 CTA 尺寸。
- 工作台按钮默认圆角为 `--radius-sm`（10px）；官网控件 12px、平台后台 12px 仅限对应表面，不构成工作台规则的另一套默认值。
- 设计规则由本文统一维护；组件 API、默认值和运行状态以实际代码为准。发生偏差时记录并修复代码或修正规范，不直接按旧原型覆盖已验证行为，也不把现存缺陷视为规范。
- `AGENTS.md` 维护执行要求与当前产品不变量，不复制完整视觉规格；通用设计技能辅助选型，遇到具体项目参数以本文及 `AGENTS.md` 为准。
- 静态原型不再作为生产设计权威；开发原型和配套图纸、样式、脚本放 `tmp/<任务>/`，不纳入 Git 或发布包。
- 保留语义化标题、button/link/input、可见焦点和完整交互状态；禁止将设计工具注入脚本、预览标注、虚构数据混入产品。

## 2. Design Tokens

### 2.1 颜色（浅色主题）

| Token | 浅色值 | 语义 |
|---|---|---|
| `--bg` | `#ffffff` | 页面背景 |
| `--fg` | `#1d1d1f` | 标题/正文主色 |
| `--fg-2` | `#424245` | 次要文字（较深灰） |
| `--muted` | `#6e6e73` | 解释/说明/引用 |
| `--meta` | `#86868b` | 元信息/时间戳/占位符 |
| `--surface` | `#f5f5f7` | 面板/卡片/泳道底 |
| `--border` | `#d2d2d7` | 主要描边/分隔 |
| `--border-soft` | `#eeeef0` | 细分隔线 |
| `--accent` | `#0071e3` | 主强调色 |
| `--accent-hover` | `#0077ed` | 主按钮 hover |
| `--accent-2` | `#6e6e73` | 渐变第二色（品牌块/图标） |
| `--accent-fg` | `#ffffff` | accent 底上的文字 |
| `--success` / `--warn` / `--danger` | 沿用现有 | 语义反馈 |
| `--status-*` | 沿用现有 | 任务/步骤状态色 |


**语义化别名**（新代码一律用别名，逐步替换直接引用）：

```css
--text-primary:   var(--fg);          /* 标题、正文 */
--text-secondary: var(--fg-2);        /* 次级说明 */
--text-muted:     var(--muted);       /* 解释、引用、辅助说明 */
--text-tertiary:  var(--meta);        /* 元信息、时间戳、placeholder */
--text-accent:    var(--accent);
--text-on-accent: var(--accent-fg);
```

### 2.2 字体栈

| Token | 值 | 说明 |
|---|---|---|
| `--font-display` | `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | 标题/数字/品牌 |
| `--font-body` | 同上 | 正文 |
| `--font-mono` | `ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace` | 代码/眉题/元信息数字 |

> 字体栈复用生产 CSS，macOS 上 system-ui 使用系统字体；不在页面另建字体默认值。

### 2.3 圆角

| Token | 值 | 用途 | 规格 |
|---|---|---|---|
| `--radius-xs` | `8px` | 输入框、侧栏项、小控件 | ✓ 8px |
| `--radius-sm` | `10px` | 按钮、KPI 卡 | 10px |
| `--radius-md` | `12px` | 卡片、列表、弹框内层 | ✓ 12px |
| `--radius-lg` | `14px` | 大卡片（feature/quote） | ✓ 14px |
| `--radius-xl` | `18px` | 大型浮层外框 | ✓ 18px |
| `--radius-pill` | `999px` | 胶囊、徽标、头像 | ✓ 999px |

### 2.4 间距

布局间距复用以下档位：

```css
--space-1: 4px;   --space-2: 8px;  --space-3: 12px; --space-4: 16px;
--space-5: 24px;  --space-6: 32px; --space-7: 48px;
```

- 卡片内边距：`--space-4`~`--space-5`；看板泳道间距 `--space-3`；区块间距 `--space-6`~`--space-7`。
- 布局数值禁止再出现 5/7/9/11/13/15 等非档位值。

### 2.5 阴影与描边

| Token | 值 | 用途 |
|---|---|---|
| `--elev-raised` | 沿用现有 `0 12px 32px rgba(0,0,0,0.08)` | 普通浮层 |
| `--elev-overlay` | `0 30px 80px rgba(0,0,0,0.06), 0 12px 30px rgba(0,0,0,0.04)` | 大型浮层 |
| `--ring` | `inset 0 0 0 1px var(--border)` | 选中态描边，替代大阴影 |
| `--focus-ring` | 沿用现有 | 键盘焦点 |

### 2.6 动效

- 沿用现有：`--motion-fast: 150ms`、`--ease: cubic-bezier(0.28, 0, 0.22, 1)`。
- 主按钮 hover：复用现有 `--accent-hover` 状态；ghost 按钮/链接项 hover：背景切换。
- 进行中状态：文字旁保留持续旋转加载图标（沿用 `.task-status-spinner`，AGENTS.md 要求）。

### 2.7 断点

工作台移动端统一以 `≤1023px` 为边界，复用 `apps/web/src/mobile.css`。现有 CSS 中的 600/920px token 及 760px 局部规则是历史实现，不能据此另建一套移动端模式；修改对应区域时核对完整级联。容器内布局按可用宽度降级，不只依赖整个视口宽度。

---

## 3. 排版规范

### 3.1 五档字号（按嵌套层级）

**工作台基础字号采用 5 档**，按信息语义和层级选择，生产值统一乘 `--font-scale`。移动端输入字号复用 `mobile.css` 的防自动缩放规则，不为套档位覆盖现有可用性约束：

| 档位 | Token | 大小 | 嵌套层级 | 用途 |
|---|---|---|---|---|
| 1 | `--text-title-1` | **20px** | 第 1 层（页面） | 页面标题、任务大标题 |
| 2 | `--text-title-2` | **16px** | 第 2 层（区块） | 区块标题、弹框标题、品牌标识 |
| 3 | `--text-title-3` | **14px** | 第 3 层（子区块） | 子标题、卡片标题、列表分组标题 |
| 4 | `--text-body` | **13px** | 第 4 层（内容） | 正文、输入、按钮、列表项 |
| 5 | `--text-caption` | **11px** | 第 5 层（辅助） | 元信息、徽标、状态、眉题、引用 |

使用规则：

- 标题字体族一律 `--font-display`；标题 20/16px 加 `letter-spacing: -0.01em~-0.02em`。
- 标题结构保持语义层级；辅助说明按内容角色选档，不能仅凭 DOM 嵌套深度不断缩小文字。
- 展示/营销语境（空状态大标题、落地页）可用 `clamp()` 显示级，**不计入 5 档**，产品 UI 内默认不用。

### 3.2 文字角色与灰阶语义

| 角色 | 颜色 | 示例 |
|---|---|---|
| 标题 | `--text-primary` | 页面/区块/子标题 |
| 正文 | `--text-primary` | 任务说明、描述 |
| 次级说明 | `--text-secondary` | 输入辅助说明、配置行说明 |
| 解释/说明/引用 | `--text-muted` | 引用块、placeholder 提示、展开说明 |
| 元信息/时间戳 | `--text-tertiary` | 时间、token 数、会话 ID、进程轨迹 |

- 引用（markdown blockquote）固定：`color: var(--text-muted)` + 左侧 3px `--border` 边框（沿用现有 `.markdown-message blockquote`）。
- 禁止把元信息/说明做成与正文同色。

### 3.3 区块眉题（eyebrow）

用于简短技术分类和元信息，采用 mono 字体和适度字距；普通中文分组标题使用标题字体，不强制套用营销眉题。

```css
.eyebrow {
  font-family: var(--font-mono);
  font-size: var(--text-caption);        /* 11px */
  text-transform: uppercase;
  letter-spacing: 0.08em;                /* 技术分类字距 */
  color: var(--text-muted);
}
```

眉题与普通分组标题按用途区分，不维护旧页面字号迁移清单。

### 3.4 Markdown 排版映射

Markdown 使用 `MarkdownMessage` 的统一样式：h1/h2/h3/h4 对应 20/16/14/13px 基础档并跟随字号缩放；引用使用 muted 色与左侧边线，代码使用 mono 字体。不要在调用页面覆盖 Markdown 的标题和代码字号。

## 4. 布局规范

### 4.1 页面骨架

统一三区骨架（`Layout.tsx` 已实现，按此收敛）：

- **侧栏**：`--bg` 底 + 右侧 `--border-soft` 分隔；导航项圆角 `--radius-xs`，选中态 `--bg` + `--ring` 描边 + 加粗。
- **顶栏**：`height: 48px` + 底部 `--border-soft` 分隔；页面级粘性导航可采用 `backdrop-filter: blur` + 半透明底，须保证正文对比度。
- **内容区**：看板/列表/设置/画布统一 `--space-4`~`--space-5` 内边距节奏；区块间 `--space-5`。

### 4.2 间距与对齐节奏

- 卡片内边距 `--space-4`（16px）；列表行 `12px 16px`；泳道间距 `--space-3`（12px）。
- 同层级元素对齐基线一致；禁止同一容器内混用 14px/16px/18px 内边距。
- 分组标题/眉题与内容间距：`--space-3`。

### 4.3 面板/卡片/弹框

- 卡片（看板卡片、设置卡、列表卡）：`--surface` 底 + `--border` 描边 + `--radius-md`；hover 轻微提亮（背景切换）。
- 弹框（`modal`）：`--bg` 底 + `--radius-xl` 外框 + `--elev-overlay`；标题 `--text-title-2`；底部操作区右对齐（沿用现有 `.modal-footer`）。
- 弹框布局约束（AGENTS.md，保持）：表单/名称放顶部，主内容区占满剩余高度且可拖动分隔条调整比例，支持四边与四角拖拽缩放，内容高度不足时优先保证可用高度。
- 侧滑面板：沿用现有交互（未变更点遮罩直接关闭；有变更先 `ConfirmDialog`）。

### 4.4 内联样式治理

固定布局、排版、尺寸和状态样式写入有语义类名的 CSS，颜色和尺寸复用 tokens。JSX 的 `style` 仅传运行时计算值（拖拽坐标、分隔比例、步骤颜色等），不混入静态规则；旧内联样式在修改所属职责时逐步迁移。

---

## 5. 组件库规范

### 5.1 三层架构

| 层 | 内容 | 约束 |
|---|---|---|
| **基础层** | `Button`、`Input`、`Select`、`Textarea`、`Field`、`Icon`、`Spinner`、`StatusBadge`、`EmptyState` | 纯展示/交互原语，props 最小化，默认值统一 |
| **组合层** | 现有公共组件：`ChatInput`、`ChatMessageBubble`、`MessageMetaBar`、`MessageResponseFooter`、`CoordinatorConfigBar`、`MarkdownEditor`、`MarkdownMessage`、`ConfirmDialog`、`Combobox`、`EngineSelect`、`DirectoryBrowser`、`FlowCanvas`、`AiFlowChat` | 复用一致性原则：两处及以上使用的 UI 必须抽公共组件，改一处全局生效 |
| **页面层** | `Layout`、`TaskList`、`TaskDetail`、`CanvasEditor`、`SettingsPage`、`TemplateSettings` | 只组装，不内联实现公共组件逻辑 |

页面层的“只组装”同时约束状态和副作用：路由级页面可以选择数据并协调区域，但完整业务流程应收口到组合模块。若一个弹框、侧栏分区或编辑器同时包含自己的局部状态、异步请求、校验、错误恢复与关闭保护，应在该功能处形成 seam，对外只暴露稳定标识与结果/关闭回调。不得把大量 state/setter 作为 props 搬到新文件制造浅模块。

以下指标是代码评审中的拆分信号，而非鼓励凑行数：文件超过 800 行、局部状态超过 15 个或 effect 超过 10 个。触发任一指标后，新增功能应先识别可独立验证的业务职责并抽离，或在变更说明中记录暂不拆分的耦合原因。行为测试跟随职责所有者；页面层测试模块组装，组合模块测试自身交互和异常路径。

实际职责所有者、API 和行为测试入口见 [Code Map](docs/code-map.md)，不在设计规范中维护易过期的文件行数和迁移统计。

### 5.2 基础层组件规范

- `Button`：变体 `primary`（accent 底 + `--accent-fg` 文字，hover `--accent-hover`）、`ghost`（`--border` 描边）、`danger`、`icon`（圆形图标钮）；尺寸 `sm`/默认；loading 态内置 `Spinner`。
- `Input`/`Select`/`Textarea`：统一高度 32px（多行除外）、`--radius-xs`、`--border` 描边、focus `--accent` 边框 + `--focus-ring`、disabled 置灰、placeholder `--text-tertiary`。
- 移动端普通按钮、输入和工具栏控件复用 `mobile.css` 的 32px 高度变量；菜单项与需要较大点击区域的控件复用 44px 变量。不要在页面样式中另写 36px、48px 等高度。消息操作小按钮保留紧凑规格。
- 任务详情头部增加操作或信息时，需在 320px、390px 和 1023px 宽度检查整行布局，优先让信息在两行内显示，保留创建者与时间，避免长任务 ID 被按钮挤到第三行。「绑定BOT」位于分享按钮左侧。较长的元信息和 ID 可限宽滚动展示，但完整值应可查看、复制；滚动效果需适配减少动态效果的系统设置。核对实际渲染中的换行与按钮点击区域。
- `Field`：label + 帮助文本 + 错误提示组合；label `--text-body` 加粗，帮助/错误提示在**固定高度区域**（`minHeight` 占位）避免布局跳动。
- `Spinner`：统一旋转加载图标（沿用手写 CSS 圆环，`currentColor`）。
- `StatusBadge`：封装现有 `.status-badge`（`data-s` 语义 + token 色），统一「进行中」附旋转加载图标。
- `EmptyState`：空列表/空画布兜底（大图标 20px+ + 说明 `--text-muted`）。

### 5.3 组合层组件规范（现有公共组件统一项）

| 组件 | 统一项 |
|---|---|
| `ChatInput` | 高度默认 `rows=1, minHeight=40, maxHeight=120`（调用方不得覆盖）；发送/停止图标固定规格（见 5.6）；图片按钮选中态 accent + 对勾徽标 |
| `ChatMessageBubble` / `MessageMetaBar` / `MessageResponseFooter` | LLM 消息一律三组件组合渲染，禁止页面另写气泡/状态栏/底部统计 |
| `CoordinatorConfigBar` | menu 变体「左标签 + 右下拉」行布局，标签常驻 |
| `MarkdownEditor` / `MarkdownMessage` | 富文本编辑/展示唯一入口；图片经 `/api/fs/upload/image` |
| `ConfirmDialog` | 所有确认交互唯一入口，禁止 `window.alert/confirm` |
| `Combobox` / `EngineSelect` / `DirectoryBrowser` | 保持现有 API，样式对齐 tokens |

### 5.4 输入组件统一规则

1. **必填校验**：普通提交按钮在缺少必填项时禁用；「AI 创建」等触发型按钮可以保持可点击，但点击后必须在弹框固定高度区域提示具体缺失字段并聚焦对应输入框。
2. 校验/错误信息使用 `--text-danger`（`--danger`），正常帮助文本 `--text-muted`。
3. 名称类输入（项目/流程名）即时校验空白字符（AGENTS.md）。
4. 新建聊天或 Markdown 编辑表单不得自建 textarea + 图片上传实现，一律复用 `ChatInput`/`MarkdownEditor`。

### 5.5 按钮/徽标视觉对齐

- 按钮：圆角 `--radius-sm`（10px）、字体 `--text-body`、主按钮 accent 底白字、ghost 描边 `--border`。
- 徽标（badge）：`--radius-pill`、`--text-caption` 11px、`--bg` 底 + `--border` 描边；上升/强调态 accent 文字 + 30% accent 描边。
- 渐变品牌块：`linear-gradient(135deg, var(--accent), var(--accent-2))`，用于品牌标识与装饰图标。

### 5.6 交互状态与加载反馈

- 进行中/审核中等异步状态：文字旁必须持续旋转加载图标；结束/暂停/等待用户操作后停止（AGENTS.md）。
- `ChatInput` 发送/停止图标固定规格（AGENTS.md，封装进 Icon 体系时保留）：发送按钮 30px 圆形；发送图标 13px SVG（`viewBox="0 0 24 24"`、`fill="none"`、`strokeWidth=1.6`、路径 `M22 2 11 13` 与 `m22 2-7 20-4-9-9-4z`）；停止为 12px 圆角方块；生成中显示旋转 spinner。

---

## 6. Icon 库规范

### 6.1 统一入口

图标通过 `apps/web/src/components/Icon.tsx` 输出，基于 lucide-react 和必要的自定义字形白名单。默认 `size=16`、`strokeWidth=2`、`color=currentColor`。新图标先加入白名单，不在页面混用图标库、字符符号或另写 SVG；品牌、媒体和发送/停止等已有专用组件保留各自语义，不能机械替换。

### 6.2 对齐与占位

- 同一类操作使用同一尺寸档位和线宽，不能逐按钮试大小；尺寸差异必须来自下表的用途差异。
- 图标容器固定宽高并禁止 flex 收缩；单行按钮中图标与文字垂直居中，多行信息行的前置图标对齐首行。
- 图标和文字间距由公共组件统一，按钮内加载动画占位与图标一致，状态切换不能挤动文字。
- 可见图标尺寸与触控热区分开设置；紧凑图标通过外层按钮提供命中范围，不通过放大图标补热区，不让相邻热区重叠。
- 字形自带留白导致的视觉偏差在公共图标映射中校正，不在页面散加 transform 或 margin。
- 图标按钮显式设定 padding 并居中，不能继承全局按钮 padding；纯图标操作提供可访问名称。

### 6.3 尺寸档位

| 档位 | 值 | 用途 |
|---|---|---|
| xs | 12 | 元信息、徽标内图标 |
| sm | 14 | 按钮、列表项图标 |
| md | 16 | 默认（导航、工具栏） |
| lg | 18 | 区块标题旁图标 |
| xl | 20+ | 空状态、大按钮 |

## 7. CSS 组织规范

### 7.1 按职责归属

当前工作台基础 tokens 和全局样式仍在 `apps/web/src/index.css`，移动端覆盖在 `apps/web/src/mobile.css`，已有组合模块使用同名 CSS。新增样式放入实际拥有该行为的公共组件或业务模块，不继续把独立业务样式堆入全局文件。按域拆分是治理方向，不能把尚未存在的 `styles/tokens.css` 等文件当成现成入口。

### 7.2 导入顺序与特异性

1. 基础 tokens 先于消费它的组件规则加载；移动端覆盖与组件 CSS 须检查实际级联结果。
2. 组件样式一律类名（`.chat-input-attach` 等），禁止标签选择器影响组件内部。
3. 高特异性防御沿用现状写法：`.modal-body label.chat-input-attach`（`label/input/select/textarea` 全局选择器与 `.modal-body label` 会覆盖组件样式时，用高特异性类防御）。
4. 同一组件样式只允许存在于一个域文件；页面不得覆盖组件类。

---

## 8. 响应式与交付验收

- 工作台移动端边界为 `≤1023px`；320、390、1023px 和桌面 1440px 为受影响界面的基础检查宽度，另检查 1024px 切换边界。涉及平板、广屏或复杂布局时补充 600、820、1366、1920px。
- 使用真实生产组件和明确标注的模拟数据进行隔离渲染；临时截图、报告、脚本放在仓库根 `tmp/<任务>/`。模拟截图不能冒充线上截图或操作手册截图。
- 同时检查默认/放大字号、中文/长译文、空态/加载/成功/错误/禁用、长标题和长 ID。复杂操作需覆盖键盘焦点、移动端触控与关闭保护。
- 检查按钮同高、图标占位和线宽一致、文本基线、组间距、单行控件不折字、信息列对齐、无意外横向溢出、无浮层遮挡和底层滚动穿透。
- 无法容纳的工具栏明确选择收起次要操作、横向滚动或整组移行；不能靠缩小文字或无规则折行掩盖问题。正文保留自然换行。
- 浮层避让安全区、软键盘与已有悬浮入口。移动端底部面板的标题、滚动内容和底部操作分区明确；桌面窗口按 `AGENTS.md` 支持四边与四角缩放及视口边界。
- 行为测试覆盖实际拥有职责的模块；运行适用测试、构建与 lint。自动测量溢出和尺寸辅助发现问题，不能替代实际渲染的视觉检查。
- 交付说明列出已检查的界面、宽度、状态与遗留缺口。没有完成视觉检查时明确说明，不能仅凭构建或测试通过宣称界面验收完成。

## 9. 页面模式与组件选型

| 意图 | 使用模式 | 禁止混用 |
|---|---|---|
| 切换同级内容区域 | 标签页：明确选中态、关联内容面板、键盘操作 | 不能呈现为一排互不相关的操作按钮 |
| 少量互斥选项或视图模式 | `SegmentedControl`，选项语义和尺寸一致 | 不能拿主操作按钮颜色伪装导航 |
| 执行动作 | `Button`；独立操作区最多一个主按钮 | 状态标签不能伪装可点击按钮 |
| 展示状态 | `StatusBadge` 或共享状态行；运行时配旋转图标 | 不能只用颜色表达状态 |
| 设置字段 | `Field` 与公共输入；标签、说明、错误分层 | 不在一行混排不同基线和高度的控件 |
| 查看详情 | 同页展开或侧栏；需独立定位/分享时用页面 | 不为简单查看强制叠加多层弹窗 |
| 聚焦编辑或确认 | 自管理弹框/面板，复用 `ConfirmDialog` 保护未保存修改 | 禁止原生 alert/confirm |

标签页底层可以使用 button 元素，关键是正确的标签页外观、选中语义、焦点与面板关系。已有业务标签页逐步收敛；尚无通用 Tabs API，不能在文档中声称已经统一。

### 9.1 通用布局约束

- **操作栏**：组内同高、统一图标与间距；短标签单行、不压缩图标；次要操作优先进入更多菜单。换行以操作组为单位，不让按钮自身变成多行。
- **信息行**：左标签、右值使用共享列布局；标签与值的首行对齐，时间/数量保持稳定宽度，长值明确采用省略并可查看完整值，或单独一行展开。
- **标题行**：图标、标题、状态、操作区分槽位；标题区域允许收缩，操作区不被挤扁。长标题截断或单独换行，不能挤散右侧操作。
- **列表/表格**：文本左对齐、数字右对齐、同列状态对齐；窄表格在自身区域滚动，不把表头挤成逐字换行。
- **设置页**：按语义分区，统一字段标签宽度和说明位置；移动端可切为上下布局，不在单个字段内临时拼接补丁。
- **聊天**：复用现有消息、输入、配置和操作组件；业务模块不修改其统一高度或另写一套工具栏。

## 10. 执行边界与治理状态

本文是统一的设计契约，并不代表所有存量页面已经达标。本次整合只修改规范、导航和原型目录，不改变生产组件外观。

开发前先确定表面（工作台/官网/平台后台）、页面模式和可复用组件；实现中优先修公共默认值，同一 UI 两处出现即复用；交付前完成第 8 章检查。扩展或移动功能职责时同步 `docs/code-map.md`。

仍需在后续代码治理中完成：公共按钮尺寸与图标占位保障、标签页统一、操作栏/信息行复用、存量静态内联样式迁移，以及持续的视觉回归检查。不能将这些目标写成已经实现的能力。

## 11. 官网与品牌视觉

本章保留原品牌视觉规范，仅适用于官网/营销展示；工作台紧凑控件使用前文规格。机器可消费的产品 tokens 以生产 CSS 为准，不再在 Markdown front matter 维护第二份参数表。

### Overview

**Creative North Star: "The Precise Workbench"**

WorkStep presents complex orchestration as a calm, inspectable workspace. The visual system is bright, restrained, and product-led: large direct statements establish confidence, while interface previews and status details provide proof without turning the page into a technical dashboard.

The system favors clear hierarchy, generous section rhythm, and familiar desktop-product surfaces. Blue signals action and active work; violet appears as a secondary orchestration cue. Motion demonstrates continuity between workflow steps and stays subordinate to comprehension.

**Key Characteristics:**

- Bright neutral canvases with sparse blue and violet emphasis.
- Large, tightly tracked headings paired with compact product detail.
- Softly lifted windows, restrained borders, and rounded controls.
- Real interface scenes used as evidence, not decorative illustration.
- Direct, calm copy that explains what the product does.

### Colors

The palette uses quiet near-white surfaces and dark neutral text so the workflow blue remains a deliberate signal rather than ambient decoration.

#### Primary

- **Workflow Blue:** The principal action, running-state, link, and focus color.
- **Active Workflow Blue:** The hover state for primary actions.

#### Secondary

- **Orchestration Violet:** A supporting cue in the brand mark and selected workflow accents.

#### Neutral

- **Canvas White:** The base page and raised window surface.
- **Soft Control Gray:** Low-contrast controls, bars, and grouped regions.
- **Lifted Paper:** Alternate sections that need separation from the base canvas.
- **Primary Ink:** Headlines, primary labels, and strong controls.
- **Secondary Ink:** Supporting labels that still need clear contrast.
- **Muted Ink:** Body support copy and metadata.
- **Quiet Ink:** Timestamps and tertiary details.
- **Separator Gray / Soft Separator:** Structural boundaries, with the softer value preferred for large regions.

#### Named Rules

**The Active Signal Rule.** Blue marks actions or live state; violet supports orchestration and never competes with the primary action.

**The Quiet Canvas Rule.** Neutral surfaces carry most of every viewport so interface evidence and active states remain legible.

### Typography

**Display Font:** System UI with Apple, Segoe UI, Roboto, and PingFang SC fallbacks  
**Body Font:** System UI with the same platform-native fallbacks  
**Label/Mono Font:** UI monospace with SF Mono, JetBrains Mono, and Menlo fallbacks

**Character:** The primary face is neutral and highly legible across Chinese and English. Monospace is reserved for engine names, status metadata, identifiers, and values that behave like technical data.

#### Hierarchy

- **Display** (700, fluid 40–66px, 1.06): Hero statements only.
- **Headline** (700, fluid 30–44px, 1.12): Major section propositions.
- **Title** (600–700, 15–20px): Cards, panels, and named product concepts.
- **Body** (400, 15–17px, 1.55–1.65): Explanations with lines kept near 52–70 characters.
- **Label** (600, 11–13px): Metadata and compact controls; uppercase is limited to short technical labels.

#### Named Rules

**The Product Voice Rule.** Use weight, scale, and spacing for emphasis; reserve monospace for information that is genuinely code-like or measurable.

### Layout

The page uses a centered container capped at 1360px with 28px horizontal gutters. Sections follow a generous 92px vertical rhythm on desktop and compress to 64px below 760px. Major propositions lead each region, followed by proof in interface previews, two-column explanations, or three-column demonstrations.

Responsive layouts reduce column count before reducing legibility: feature and collaboration grids collapse progressively, navigation links hide on narrow screens, and primary calls to action become full-width stacks around 600px. DOM order remains the reading order.

### Elevation & Depth

Depth is a hybrid of tonal layering, fine separators, and a single ambient elevation. Most surfaces stay flat; large product windows and hovered demonstration cards use a soft two-stage shadow to distinguish interactive evidence from the page.

#### Shadow Vocabulary

- **Ambient Window:** `0 30px 80px rgba(0, 0, 0, 0.07), 0 12px 30px rgba(0, 0, 0, 0.05)` for product windows, modals, and elevated evidence.
- **Interactive Lift:** The ambient window shadow paired with a 4px upward translation on hover.

#### Named Rules

**The Evidence Lifts Rule.** Elevation belongs to product previews, modal focus, and interactive response—not ordinary copy containers.

### Shapes

Controls use gently rounded 12px corners, content panels use 14px, and application windows use 18px. Pills are restricted to compact actions, filters, and status badges. Thin neutral borders define structure; the blue-to-violet gradient is reserved for the compact WorkStep mark and small signature accents.

### Components

#### Buttons

- **Shape:** Confident rounded rectangle (12px); compact navigation actions may use a pill.
- **Primary:** Workflow blue with white text and 12px × 20px padding.
- **Hover / Focus:** Shift to active blue with a subtle 1px lift; keyboard focus uses a 2px blue outline and 2px offset.
- **Secondary / Ghost:** Canvas surface, primary ink, and a neutral border; hover changes the surface tone.

#### Chips

- **Style:** Compact pill geometry with muted neutral surfaces and short labels.
- **State:** Active or live chips may use blue or success green; passive chips remain neutral.

#### Cards / Containers

- **Corner Style:** 14–18px depending on scale.
- **Background:** Canvas or lifted paper.
- **Shadow Strategy:** Flat at rest unless the card is primary evidence or interactive.
- **Border:** One-pixel neutral separator.
- **Internal Padding:** Compact 14–20px for interface cards; larger prose compositions rely on surrounding layout gaps.

#### Navigation

The sticky 64px navigation uses a translucent canvas with saturation blur and a soft bottom separator. Links are compact and muted until hover; the main action uses inverted ink and canvas colors.

#### Workflow Preview

Application previews combine neutral chrome, compact technical labels, real status colors, and continuous motion. They should read as plausible product UI at a glance and remain the richest visual regions on the page.

### Do's and Don'ts

#### Do:

- **Do** keep most surfaces neutral and spend saturated color on actions, active workflow state, and small signature cues.
- **Do** use generous spacing between propositions and tighter spacing inside interface evidence.
- **Do** preserve real workflow motion and product-state detail when rearranging the page.
- **Do** keep Chinese and English hierarchy equivalent across responsive sizes.

#### Don't:

- **Don't** replace product evidence with generic decorative cards or abstract illustrations.
- **Don't** apply ambient shadows to every container.
- **Don't** use monospace as a general-purpose technology aesthetic.
- **Don't** invent performance, security, or adoption claims that the product cannot substantiate.


## 12. 平台管理后台


管理后台使用紧凑规格：页面标题 24px、分区标题 16px、表单与表格 14px、导航项 13px、菜单分类 12px、辅助标记 11px；桌面表单控件高度 36px、圆角 12px，内容面板圆角 14px、主区域圆角 18px。侧栏使用浅色中性背景，蓝色只强调当前分类及操作；二级菜单默认收起。1023px 及以下通过顶部按钮打开模态抽屉菜单，导航点击区域 44px、普通控件 32px；窄表格在自身区域滚动，搜索栏根据内容区宽度调整布局。该规格适用于 `apps/gateway-web` 的管理区域，登录及门户页面保留现有规格。颜色复用上述调色板，表格在窄空间内横向滚动，禁止把表头和状态挤成逐字换行。
