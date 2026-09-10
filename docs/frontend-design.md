# WorkStep 前端设计规范（Design System）

> **状态**：定稿（v1.0，2026-08-07）｜**适用范围**：`apps/web` 全部页面与组件
> **视觉契约源**：`ui/DESIGN/DESIGN.md` + `ui/DESIGN/index.html`（Apple 风格视觉系统导出件，保持原样，仅作契约参考）
> **配套文件**：`AGENTS.md`（交互/功能约束，与本文档并行生效）｜`plans/05-frontend.md`（技术架构，延续其「颜色必须来自全局 CSS token」原则）

---

## 1. 设计契约与来源

### 1.1 视觉契约源

前端开发必须以 `ui/DESIGN/` 下导出件为视觉基准：

- `ui/DESIGN/DESIGN.md` —— 视觉契约（fidelity / responsive / CJX-ready / color 契约）；
- `ui/DESIGN/index.html` —— 唯一设计源文件（44KB，含全部 tokens 与组件样式；导出件未检出独立 CSS/JS/DESIGN-MANIFEST.json，故以该文件为 token 提取基准）。

### 1.2 契约要点（转译自 DESIGN.md）

1. **从导出设计构建，不做松散重诠释**：保留排版、间距节奏、色彩 tokens、圆角、阴影、动效与组件状态。
2. **token 先行**：写任何组件前先抽取 tokens（背景/前景/次要文字/边框/accent/圆角/阴影/间距/字号/动效），禁止硬编码十六进制。
3. **生产代码无设计工具痕迹**：`ui/DESIGN/index.html` 内含 `data-od-*` 脚本（sandbox-shim、tweaks-bridge、srcdoc-transport、snapshot）与「Apple · live preview」等标注，**一律不得进入生产代码**。
4. **组件状态齐全**：hover / focus / pressed / disabled / loading / validation / modal/sheet / keyboard 状态需保留。
5. **无障碍**：标题层级保持语义化（h1→h2→h3），控件保持 button/input/link 语义，focus 状态可见。
6. **占位内容替换为真实数据**：营销页文案（"The system that makes Apple feel like Apple" 等）是设计工具生成的占位，不得照搬进产品 UI。

### 1.3 优先级规则

| 冲突场景 | 以谁为准 |
|---|---|
| 视觉层：颜色/字号/间距/圆角/阴影/动效 | 本文档（提取自 `ui/DESIGN/index.html`） |
| 交互层：弹框确认、必填校验、侧滑面板、聊天输入等行为 | `AGENTS.md` 与现有公共组件 |
| 组件 API / props / 默认值 | 现有公共组件定义（组合层章节），改动须先改公共组件再全局生效 |
| 状态色（任务/阶段） | `plans/05-frontend.md` 状态颜色规范，沿用现有 token |

### 1.4 范围边界

产品 UI（看板、画布、对话、设置）全面对齐本视觉系统。营销页独有元素——`hero`、`logos`、`pricing`、`quote`、`faq`、`cta`、`footer`——**仅作风格参考**，不作为产品 UI 模板；可借鉴其组件模式：粘性导航、按钮、徽标、卡片、侧栏导航项、KPI 卡、列表行。

---

## 2. Design Tokens

### 2.1 颜色（浅色主题）

| Token | 浅色值 | 语义 | 设计源 |
|---|---|---|---|
| `--bg` | `#ffffff` | 页面背景 | ✓ |
| `--fg` | `#1d1d1f` | 标题/正文主色 | ✓ |
| `--fg-2` | `#424245` | 次要文字（较深灰） | 保留现有 |
| `--muted` | `#6e6e73` | 解释/说明/引用 | ✓ |
| `--meta` | `#86868b` | 元信息/时间戳/占位符 | 保留现有 |
| `--surface` | `#f5f5f7` | 面板/卡片/泳道底 | ✓（现有 `#f6f6f7` → 对齐） |
| `--border` | `#d2d2d7` | 主要描边/分隔 | ✓（现有 `#e5e5e7` → 对齐） |
| `--border-soft` | `#eeeef0` | 细分隔线 | 保留现有 |
| `--accent` | `#0071e3` | 主强调色 | ✓ |
| `--accent-hover` | `#0077ed` | 主按钮 hover | 保留现有 |
| `--accent-2` | `#6e6e73` | 渐变第二色（品牌块/图标） | 新增（设计源） |
| `--accent-fg` | `#ffffff` | accent 底上的文字 | 新增（设计源） |
| `--success` / `--warn` / `--danger` | 沿用现有 | 语义反馈 | 保留 |
| `--status-*` | 沿用现有 | 任务/阶段状态色 | 保留（暗色模式同样沿用） |

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
| `--font-display` | `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | 标题/数字/品牌（设计源） |
| `--font-body` | 同上 | 正文（设计源） |
| `--font-mono` | `ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace` | 代码/眉题/元信息数字 |

> 迁移动作：现有 `--font-display/-body` 的 "SF Pro Display/Text, Helvetica Neue" 前缀统一替换为设计源字体栈（macOS 上 system-ui 即渲染为 SF Pro，效果一致）。

### 2.3 圆角

| Token | 值 | 用途 | 设计源 |
|---|---|---|---|
| `--radius-xs` | `8px` | 输入框、侧栏项、小控件 | ✓ 8px |
| `--radius-sm` | `10px` | 按钮、KPI 卡 | ✓ 10px（现有 sm=8px 属迁移动作） |
| `--radius-md` | `12px` | 卡片、列表、弹框内层 | ✓ 12px |
| `--radius-lg` | `14px` | 大卡片（feature/quote） | ✓ 14px |
| `--radius-xl` | `18px` | 大型浮层外框 | ✓ 18px |
| `--radius-pill` | `999px` | 胶囊、徽标、头像 | ✓ 999px |

### 2.4 间距

设计源节奏（4/6/8/10/12/14/16/18/22/24/26/28/32/36/44/48/56/64/96）收敛为幂等档位：

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
| `--elev-overlay` | `0 30px 80px rgba(0,0,0,0.06), 0 12px 30px rgba(0,0,0,0.04)` | 大型浮层（设计源 preview-frame） |
| `--ring` | `inset 0 0 0 1px var(--border)` | 选中态描边（设计源 side-link.active，替代大阴影） |
| `--focus-ring` | 沿用现有 | 键盘焦点 |

### 2.6 动效

- 沿用现有：`--motion-fast: 150ms`、`--ease: cubic-bezier(0.28, 0, 0.22, 1)`。
- 主按钮 hover：`filter: brightness(1.06)`（设计源）；ghost 按钮/链接项 hover：背景切换。
- 进行中状态：文字旁保留持续旋转加载图标（沿用 `.task-status-spinner`，AGENTS.md 要求）。

### 2.7 断点

```css
--bp-mobile: 600px;  /* 设计源 600 */
--bp-tablet: 920px;  /* 设计源 920 */
```

- 现有 `760px` 设置页断点保留为局部断点。
- 产品 UI 桌面优先（1366/1440/1920 先达标），逐步覆盖 DESIGN 源视口矩阵（见第 8 章）。

### 2.8 现有值 → 设计源值映射表（迁移基线）

| Token | 现状（2026-08-07） | 目标 |
|---|---|---|
| `--surface` | `#f6f6f7` | `#f5f5f7` |
| `--border` | `#e5e5e7` | `#d2d2d7` |
| `--radius-sm` | `8px` | `10px` |
| `--font-display/-body` | `"SF Pro Display/Text", ...` | `system-ui, -apple-system, 'Segoe UI', Roboto` |
| 新增 `--accent-2` / `--accent-fg` / `--elev-overlay` / `--ring` | 无 | 见上文 |
| 其余（`--bg`/`--fg`/`--muted`/`--meta`/`--accent`/`--radius-md`/状态色） | 与设计源一致 | 不变 |

---

## 3. 排版规范

### 3.1 五档字号（按嵌套层级）

**全站最多 5 档字号**，字号由嵌套层级决定，层级越深字号越小：

| 档位 | Token | 大小 | 嵌套层级 | 用途 |
|---|---|---|---|---|
| 1 | `--text-title-1` | **20px** | 第 1 层（页面） | 页面标题、任务大标题 |
| 2 | `--text-title-2` | **16px** | 第 2 层（区块） | 区块标题、弹框标题、品牌标识 |
| 3 | `--text-title-3` | **14px** | 第 3 层（子区块） | 子标题、卡片标题、列表分组标题 |
| 4 | `--text-body` | **13px** | 第 4 层（内容） | 正文、输入、按钮、列表项 |
| 5 | `--text-caption` | **11px** | 第 5 层（辅助） | 元信息、徽标、状态、眉题、引用 |

使用规则：

- 标题字体族一律 `--font-display`；标题 20/16px 加 `letter-spacing: -0.01em~-0.02em`。
- 层级不可跳级：页面上不允许出现「页面标题下直接挂 11px 说明」以外的跳档（辅助性说明除外）。
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

设计源特征（`hero-eyebrow` / `section-eyebrow` / `side-section`）：mono 字体 + 大写 + 字距。

```css
.eyebrow {
  font-family: var(--font-mono);
  font-size: var(--text-caption);        /* 11px */
  text-transform: uppercase;
  letter-spacing: 0.08em;                /* 设计源 0.08~0.1em */
  color: var(--text-muted);
}
```

现有 `Layout.tsx` 的 `sectionLabel`（12px uppercase）与 `TaskDetail`「进度」眉题（15px uppercase）迁移到本规范（`--text-caption` 11px + mono + 0.08em）。

### 3.4 Markdown 排版映射

`apps/web/src/index.css` 内 `.markdown-message` 标题档位迁移：

| 元素 | 现状 | 目标档位 |
|---|---|---|
| `h1` | 18px | title-1 20px |
| `h2` | 16px | title-2 16px |
| `h3` | 14px | title-3 14px |
| `h4` | 13px | body 13px |
| `blockquote` | `--muted` + 3px 左边框 | 保持（即 3.2 引用规范） |
| `code` / `pre` | `--font-mono` 0.9em / 11px | 保持 |

### 3.5 旧字号迁移映射表（2026-08-07 基线）

现状共 **10 个不同字号值**（9/10/11/12/13/14/15/16/18/22px），映射到 5 档：

| 旧字号 | 现状示例 | 目标档位 |
|---|---|---|
| 22px | Settings/TemplateSettings 页面 `<h1>` | title-1 20px |
| 18px | TaskDetail 任务大标题、markdown h1 | title-1 20px |
| 16px | App 品牌字、markdown h2 | title-2 16px |
| 15px | ConfirmDialog/弹框标题、节点标签、「进度」眉题 | title-3 14px（眉题见 3.3） |
| 14px | 页面正文、侧栏项、设置卡片正文 | body 13px |
| 13px | 正文/输入/按钮 | body 13px |
| 12px | 次级标签、配置行、`sectionLabel` 眉题 | 正文级 → body 13px；说明/元信息/眉题级 → caption 11px |
| 11px | 徽标、状态、元信息 | caption 11px |
| 10px | 更次级说明、`side-section` mono 眉题 | caption 11px |
| 9px | 最小辅助文字 | caption 11px |

> 12px 是唯一需要按语义判断的档位：正文级归 body，辅助级归 caption；不允许新增 12px。

---

## 4. 布局规范

### 4.1 页面骨架

统一三区骨架（`Layout.tsx` 已实现，按此收敛）：

- **侧栏**：`--bg` 底 + 右侧 `--border-soft` 分隔；导航项圆角 `--radius-xs`，选中态 `--bg` + `--ring` 描边 + 加粗（设计源 `side-link.active`）。
- **顶栏**：`height: 48px` + 底部 `--border-soft` 分隔；页面级粘性导航参考设计源 `nav`（可加 `backdrop-filter: blur` + 半透明底）。
- **内容区**：看板/列表/设置/画布统一 `--space-4`~`--space-5` 内边距节奏；区块间 `--space-5`。

### 4.2 间距与对齐节奏

- 卡片内边距 `--space-4`（16px）；列表行 `12px 16px`（对齐设计源 `list-row`）；泳道间距 `--space-3`（12px）。
- 同层级元素对齐基线一致；禁止同一容器内混用 14px/16px/18px 内边距。
- 分组标题/眉题与内容间距：`--space-3`。

### 4.3 面板/卡片/弹框

- 卡片（看板卡片、设置卡、列表卡）：`--surface` 底 + `--border` 描边 + `--radius-md`；hover 轻微提亮（背景切换）。
- 弹框（`modal`）：`--bg` 底 + `--radius-xl` 外框 + `--elev-overlay`；标题 `--text-title-2`；底部操作区右对齐（沿用现有 `.modal-footer`）。
- 弹框布局约束（AGENTS.md，保持）：表单/名称放顶部，主内容区占满剩余高度且可拖动分隔条调整比例，支持右下角拖拽缩放，内容高度不足时优先保证可用高度。
- 侧滑面板：沿用现有交互（未变更点遮罩直接关闭；有变更先 `ConfirmDialog`）。

### 4.4 内联样式治理

现状基线（2026-08-07）：**673 处内联 `style={{...}}` + 12 个命名 `React.CSSProperties` 常量**（TaskList/Layout/FlowCanvas/EngineConfigForm/Combobox）。「布局乱」根因即布局数值散落内联。

规则：

1. **不再新增**内联 `style` 承载布局/排版数值；一律使用 tokens、公共类或公共组件。
2. 现有 12 个命名常量（如 `sidebarStyle`、`topbarStyle`、`laneStyle`）迁入 CSS 类。
3. 颜色一律走 tokens（延续 `plans/05-frontend.md`：禁止组件内另写十六进制）。
4. 例外：仅动态值（拖拽坐标、弹性尺寸）允许内联。

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

截至 2026-09-10 的结构审计中，以下模块已触发拆分信号，后续修改应优先沿所列 seam 收口，而不是继续向原文件追加：

| 优先级 | 模块 | 主要混合职责 | 建议 seam |
|---|---|---|---|
| P0 | `TaskDetailView.tsx` | 只读/编辑视图、阶段时间线、消息、审核、产物和多个编辑区 | 按任务头部、阶段导航、对话时间线、审核与产物区拆成组合模块，页面只传领域数据和用户意图 |
| P0 | `FlowCanvas.tsx` | 数据迁移、图布局、节点渲染、画布交互、校验和保存 | 纯数据转换与校验、节点展示、画布控制器分别形成可测试 seam |
| P0 | `SettingsPage.tsx` | 设置导航、引擎安装、助手配置和多个设置分区 | 由 section registry 组装独立设置分区，页面仅维护当前分区和跨分区刷新 |
| P1 | `TaskDetail.tsx` | 项目解析、历史同步、实时事件、面板几何和会话控制 | 数据/实时协调 hook 与面板外壳分离，视图交给 `TaskDetailView` 的后续子模块 |
| P1 | `TaskList.tsx` | 看板、拖拽、筛选、新建任务和 AI 创建 | 看板控制器与任务创建面板分离，新建流程自行拥有草稿、校验和关闭保护 |
| P2 | `ProviderSettings.tsx`、`ChatInput.tsx`、`ChatPage.tsx` | 表单状态或会话副作用集中，接口持续扩张 | 分别按供应商编辑、输入附件/配置、会话加载/发送队列建立 seam |

`Layout.tsx` 已先移出流程创建、项目连接和侧栏活动同步；剩余侧栏树与菜单仍是后续拆分对象，新功能不得重新放回 `Layout`。

### 5.2 基础层组件规范

- `Button`：变体 `primary`（accent 底 + `--accent-fg` 文字，hover `brightness(1.06)`）、`ghost`（`--border` 描边）、`danger`、`icon`（圆形图标钮）；尺寸 `sm`/默认；loading 态内置 `Spinner`。
- `Input`/`Select`/`Textarea`：统一高度 32px（多行除外）、`--radius-xs`、`--border` 描边、focus `--accent` 边框 + `--focus-ring`、disabled 置灰、placeholder `--text-tertiary`。
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

1. **必填校验**：按钮不置灰；点击后在弹框内提示具体缺失字段并聚焦对应输入框；提示放固定高度区域，不塞 `title`、不挤压布局。
2. 校验/错误信息使用 `--text-danger`（`--danger`），正常帮助文本 `--text-muted`。
3. 名称类输入（项目/流程名）即时校验空白字符（AGENTS.md）。
4. 新表单不得自建 textarea + 图片上传实现，一律复用 `ChatInput`/`MarkdownEditor`。

### 5.5 按钮/徽标视觉对齐（设计源）

- 按钮：圆角 `--radius-sm`（10px）、字体 `--text-body`、主按钮 accent 底白字、ghost 描边 `--border`。
- 徽标（badge）：`--radius-pill`、`--text-caption` 11px、`--bg` 底 + `--border` 描边；上升/强调态 accent 文字 + 30% accent 描边（设计源 `.badge.up`）。
- 渐变品牌块：`linear-gradient(135deg, var(--accent), var(--accent-2))`（设计源 brand-mark/feature-icon），用于品牌标识与装饰图标。

### 5.6 交互状态与加载反馈

- 进行中/审核中等异步状态：文字旁必须持续旋转加载图标；结束/暂停/等待用户操作后停止（AGENTS.md）。
- `ChatInput` 发送/停止图标固定规格（AGENTS.md，封装进 Icon 体系时保留）：发送按钮 30px 圆形；发送图标 13px SVG（`viewBox="0 0 24 24"`、`fill="none"`、`strokeWidth=1.6`、路径 `M22 2 11 13` 与 `m22 2-7 20-4-9-9-4z`）；停止为 12px 圆角方块；生成中显示旋转 spinner。

---

## 6. Icon 库规范

### 6.1 引入 lucide-react

- 新增依赖 `lucide-react`（与设计源手写 SVG 同源同风格，tree-shaking 按需打包）。
- 禁止再手写内联 `<svg>`；现状 **37 处**内联 `<svg>` 迁移到统一 `Icon` 组件。

### 6.2 统一 `Icon` 封装

```tsx
// components/Icon.tsx（封装 lucide-react，统一 props）
<Icon name="send" size={14} strokeWidth={1.75} />
```

- 默认 `size=16`、`strokeWidth=2`、`color=currentColor`、`aria-hidden` 自动处理。
- 命名：`kebab-case` 图标名映射 lucide 导出；`Icon` 组件内部维护白名单，未收录图标先加入白名单再使用。
- 语义图标（发送/停止等）以 5.6 规格为准，封装为 `IconButton`/固定规格。

### 6.3 尺寸档位

| 档位 | 值 | 用途 |
|---|---|---|
| xs | 12 | 元信息、徽标内图标 |
| sm | 14 | 按钮、列表项图标 |
| md | 16 | 默认（导航、工具栏） |
| lg | 18 | 区块标题旁图标 |
| xl | 20+ | 空状态、大按钮 |

### 6.4 替换清单（37 处，按文件）

| 文件 | 内联 `<svg>` 数 | 迁移 |
|---|---|---|
| `apps/web/src/pages/TaskList.tsx` | 12 | 列表/操作/空状态图标 |
| `apps/web/src/components/Layout.tsx` | 6 | 侧栏/导航/操作图标 |
| `apps/web/src/components/ChatInput.tsx` | 6 | 发送/停止/图片/下拉（保留 5.6 固定规格） |
| `apps/web/src/pages/TaskDetail.tsx` | 4 | 对话/详情图标 |
| `apps/web/src/pages/SettingsPage.tsx` | 3 | 设置图标 |
| `apps/web/src/components/MessageResponseFooter.tsx` | 2 | 复制/统计图标 |
| `apps/web/src/components/ArtifactPreview.tsx` | 2 | 预览图标 |
| `apps/web/src/components/MessageMetaBar.tsx` | 1 | 元信息图标 |
| `apps/web/src/App.tsx` | 1 | 启动页图标 |

验收：`rg "<svg" apps/web/src -g '*.tsx'` 仅剩 `Icon.tsx` 内部。

---

## 7. CSS 组织规范

### 7.1 按域拆分

`index.css`（现状 863 行单文件）按域拆分，入口 `index.css` 仅 `@import` 各域文件（tokens 永远最先）：

```text
styles/tokens.css       # :root 变量 + 暗色主题（颜色/字体/圆角/间距/阴影/动效/断点）
styles/base.css         # reset、body、button、input/select/textarea 基础、滚动条、工具类
styles/chat.css         # ChatInput、消息三组件、流程轨迹（process-trace）
styles/markdown.css     # MarkdownMessage / MarkdownEditor
styles/modal.css        # modal、侧滑面板、ConfirmDialog
styles/components.css   # 徽标/状态、卡片、按钮变体、FlowCanvas 等组件
styles/pages.css        # 看板、设置、模板等页面级布局
```

### 7.2 导入顺序与特异性

1. `tokens.css` 最先；其余域按上述顺序，页面级最后。
2. 组件样式一律类名（`.chat-input-attach` 等），禁止标签选择器影响组件内部。
3. 高特异性防御沿用现状写法：`.modal-body label.chat-input-attach`（`label/input/select/textarea` 全局选择器与 `.modal-body label` 会覆盖组件样式时，用高特异性类防御）。
4. 同一组件样式只允许存在于一个域文件；页面不得覆盖组件类。

---

## 8. 响应式契约

- **桌面优先**：产品 UI 先保证 1366×768 / 1440×900 / 1920×1080 布局完整、无横向溢出。
- **视口矩阵**（DESIGN.md 契约，按序覆盖）：360×800、390×844、430×932、600×960、820×1180、1024×768、1366×768、1440×900、1920×1080。
- **语义断点**：`600px`（单列）/ `920px`（双列）/ 桌面。
- 看板泳道：桌面多列；窄视口（≤920px）允许泳道横向滚动，不做错位换行。
- 弹框/面板等以组件宽度而非视口宽度决策布局时，用 container query 思路；排版/间距的流式变化用 `clamp()`（营销/展示语境）。
- 设置页现有 `760px` 局部断点保留。

---

## 9. 迁移路线图

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| 0 | 本文档定稿 | 文档事实核对通过（映射表与现状一致） |
| 1 | tokens + 排版落地：更新 `index.css` 变量（2.8 映射表）、5 档字号 tokens、机械替换旧字号 | `rg` 统计 fontSize 仅剩 5 档（营销/展示除外）；无新增硬编码十六进制 |
| 2 | Icon 库：安装 `lucide-react`、新建 `Icon.tsx`、替换 37 处内联 SVG | `rg "<svg"` 仅剩 Icon 组件；构建通过 |
| 3 | 基础输入组件：`Button`/`Input`/`Select`/`Textarea`/`Field`/`Spinner`/`StatusBadge`/`EmptyState` 落地并迁移表单 | 输入组件 props 统一；必填校验固定高度提示；无重复输入实现 |
| 4 | 逐页迁移（顺序）：Layout → TaskList → TaskDetail → Settings → TemplateSettings → CanvasEditor | 每页内联 style 显著下降；布局对齐第 4 章；673 处内联 style 逐步趋零 |
| 5 | 视觉回归：对照设计源视觉系统、视口矩阵抽查、明暗模式 | 截图对比通过；AGENTS.md 规范逐条过；`npm run build` + `oxlint` 通过 |

> 每个阶段独立可交付、可回滚；阶段间不阻塞（一次只改一个域）。

---

## 10. 验收标准与自查清单

**设计规范（本文档）**

- [ ] 全站字号 ≤5 档（20/16/14/13/11），按嵌套层级使用
- [ ] 标题用 `--font-display`；解释/引用/元信息一律灰色 tokens（`--text-muted`/`--text-tertiary`）
- [ ] 颜色全部来自 CSS tokens，无组件内十六进制
- [ ] 间距/圆角/阴影只用档位 tokens
- [ ] 不再新增内联 `style` 布局常量；现状 673 处逐步清零
- [ ] 37 处内联 `<svg>` 全部收敛到 `Icon` 组件

**AGENTS.md 交互约束（不得回退）**

- [ ] 无 `window.alert/confirm`，确认一律 `ConfirmDialog`
- [ ] 必填校验：按钮不置灰、点击后提示缺失字段并聚焦、提示固定高度区域
- [ ] 侧滑面板未变更点遮罩直接关；有变更先确认
- [ ] 项目/流程名禁止空白字符（前端即时校验）
- [ ] 聊天输入统一 `ChatInput`（rows=1/min40/max120），发送/停止图标规格不变
- [ ] LLM 消息统一三组件渲染；markdown 编辑统一 `MarkdownEditor`
- [ ] 进行中/审核中状态旁持续旋转加载图标
- [ ] 弹框内公共组件不受 `.modal-body label` 全局样式污染（高特异性防御）

**DESIGN.md 契约（不得违背）**

- [ ] 生产代码无 `data-od-*` 脚本与设计工具标注
- [ ] 无暖米色/奶油/桃色背景wash（设计源无此色）
- [ ] hover/focus/pressed/disabled/loading/validation 状态齐全，focus 可见
- [ ] 标题层级语义化；营销页独有元素未混入产品 UI
- [ ] 视口矩阵抽查无横向溢出
