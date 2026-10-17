# 皮肤 v2：CSS、布局和浏览器本地功能

v1 皮肤继续使用原格式。需要自由 CSS 或新增日历、便签等功能时，使用 v2；不需要修改应用源码或重启服务。

## 包格式

```text
my-skin/
  skin.json
  theme.css     # 可选
  theme.js      # 可选，自包含 ES module
  assets/       # 可选，PNG/JPEG/WebP/WOFF2
```

v2 所有 JSON 配置放在 `skin.json`，不同时提供 `tokens.json` 或 `components.json`：

```json
{
  "id": "my-workspace",
  "name": "我的工作台",
  "version": "1.0.0",
  "schema_version": 2,
  "color_scheme": "light",
  "tokens": { "accent": "#0071e3" },
  "layout": { "sidebarSide": "right", "composerPosition": "left" },
  "effects": { "reveal": true, "charsPerSecond": 90, "maxDurationMs": 4000 },
  "menus": [{
    "id": "tools", "label": "工具", "position": "top",
    "items": [{ "label": "日历", "action": "feature.open", "args": { "id": "calendar" } }]
  }]
}
```

`tokens/styles/layout/desktop/mobile` 沿用共享契约；`composerPosition` 支持 `top/bottom/left/right`，紧凑界面保持上下排列。吐字速度为每秒 10–1000 字符，追赶上限为 10–10000ms；帧间隔仍保持原有下限，系统减少动态效果偏好会关闭吐字动画。历史正文不重新播放。

## CSS 和布局

`theme.css` 在默认样式和 v2 配置之后加载。普通声明不强制添加 `!important`。支持普通选择器、CSS 变量、Grid/Flex、伪元素、过渡，以及 `@media`、`@supports`、`@container`、`@layer`、`@keyframes` 和 `@font-face`；暂不接受 CSS 嵌套选择器、`@import` 或外部资源。资源使用 `url("assets/background.webp")`。后台解析 CSS，添加皮肤作用域、重命名动画并解析不可变资源地址；前端负责网关和项目查询参数。

稳定标识包括 `[data-ui="workspace"]`、`app-shell`、`main`、`navigation`、`conversation`、`chat-header`、`conversation-layout`、`messages`、`message`、`composer`、`settings`、`feature-panel` 和 `extension-menu`。

原设置的选项、顺序、分组、校验和保存逻辑继续由应用负责，只开放样式。不要用组件扩展修改设置 DOM 或复制设置表单。输入区位置由布局配置协调缩放方向和浮层定位；自定义间距、边框、背景和动画放在 CSS。

## 可执行组件 SDK

`theme.js` 必须自包含，不依赖运行时 JSX 编译，不导入应用内部模块，也不打包第二份 React：

```js
export function activate(api) {
  const { createElement: h, useEffect, useState } = api.React
  function Notes({ storage, onDirtyChange }) {
    const [text, setText] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => {
      let active = true
      storage.get('text').then(value => {
        if (active) { setText(value ?? ''); setLoaded(true) }
      }).catch(reason => { if (active) setError(reason.message) })
      return () => { active = false }
    }, [storage])
    return h('section', null,
      error && h('p', { role: 'alert' }, error),
      h('textarea', { value: text, disabled: !loaded, onChange: event => {
        setText(event.target.value); onDirtyChange?.(true)
      } }),
      h(api.components.Button, { disabled: !loaded, onClick: async () => {
        try { await storage.set('text', text); onDirtyChange?.(false) }
        catch (reason) { setError(reason.message) }
      } }, '保存'))
  }
  return api.features.register({ id: 'notes', title: '便签', render: Notes })
}
```

- `features.register({id,title,render})`：注册独立功能面板；自动提供入口，菜单已经引用该功能时不重复显示。`render` 是 React 组件，接收 `{storage,close,onDirtyChange}`。表单未保存时调用 `onDirtyChange(true)`，宿主关闭前会确认。成功持久化后调用 `onDirtyChange(false)`。
- `slots.register({id,title,slot,render})`：在固定区域添加组件。插槽为 `workspace-top/bottom/left/right`、`chat-header`、`composer-before/after`；组件自行保存数据，插槽不提供独立面板的关闭保护。
- `actions.execute(id,args)` / `enabled(id)`：调用已有操作。内置动作有 `navigate`（`{path}`）、`settings.open`（`{section}`）、`appearance.open`、`chat.new`、`input.set`（`{text}`）、`chat.send`、`chat.stop`、`action.run`（`{id}`）。聊天动作绑定当前已挂载会话；后台继续校验权限。`feature.open` 是声明式菜单专用动作。
- `actions.register(id,handler)`：注册当前扩展自己的动作；返回注销函数。不要覆盖内置动作名称。
- `context.get()/subscribe(listener)`：读取并订阅当前聊天的项目／会话／任务与只读状态；没有聊天时可以为空。
- `client.request(path,options)`：复用应用 API 客户端的认证、网关及 GET 去重；路径相对于 `/api`，项目参数遵循现有 API。新增功能可完全不使用后端。
- `storage(featureId)`：为一个稳定功能 ID 获取异步本地存储。
- `asset("assets/image.png")`：获取当前包的资源 URL，含正确设备和项目范围。
- `components`：当前提供 `Button`、`Input`、`ConfirmDialog`；`React` 为应用自己的实例。
- `signal`：停用扩展时中止。事件监听使用 `{signal: api.signal}`，计时器等额外资源在返回的清理函数中释放。模块顶层不得执行副作用；操作放在 `activate` 或用户触发的处理器内。

## 存储与生命周期

IndexedDB 数据按当前身份／设备作用域、皮肤 ID 和功能 ID 隔离。`get/set/delete/list` 均异步；数据为 JSON。`export()` 返回 `{format:"workstep-feature-data",version:1,entries:[...]}`，`import(backup)` 在单个事务中替换当前功能数据；失败不部分写入。存储错误必须显示，不能把内存中的值称为“已保存”。

升级版本、切换或删除皮肤不自动删除功能数据。皮肤 ZIP 不包含用户数据；浏览器、设备或不同访问地址／端口之间不自动同步，清理浏览器存储会清除这些数据。功能应提供单独的备份入口。

脚本按身份、设备和包摘要明确启用。代码与当前页面拥有相同权限，SDK 是复用接口，不是安全沙箱。缩略图不运行代码；全站预览经启用后可运行，取消只恢复界面，不撤销已经执行的业务操作。注册的组件、动作和订阅随停用清理，渲染错误隔离在组件内。

v2 页面提供恢复默认入口；无法操作时，在页面 URL 加上 `skin=default` 后刷新，启动阶段会跳过自定义包和代码。

## 安装与验证

通过现有 `workstep skin validate <绝对目录> --json` 校验，再用 `workstep skin register <绝对目录> --json` 安装，或在设置 → 外观的高级包入口校验和注册。更新同名包使用 `--replace`。然后预览并应用；首次启用组件需确认。格式校验不代表实际界面已通过视觉验收。

组件由皮肤作者按上述 SDK 创建并随皮肤包提供，应用不附带日历等示例功能。通用行为测试位于 `apps/web/tests/skinExtensions.test.ts` 和 `skinExtensionHost.test.tsx`，覆盖本地存储、启用、切换清理和失败恢复。
