# 自定义皮肤：CSS、布局和浏览器本地功能

自定义皮肤支持外观、自由 CSS、布局、菜单及日历、便签等浏览器本地功能，不需要修改应用源码或重启服务。制作技能统一生成包含脚本文件的皮肤包，不要求用户选择格式版本；已有皮肤仍可加载。

## 包格式

```text
my-skin/
  skin.json
  theme.css     # 可选
  theme.js      # 制作时必备，自包含 ES module；无脚本功能时为空文件
  assets/       # 可选，PNG/JPEG/WebP/WOFF2
```

所有 JSON 配置放在 `skin.json`，技术字段 `schema_version` 固定为 2，不同时提供 `tokens.json` 或 `components.json`：

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

每个制作的皮肤包都必须包含 `theme.js`，不需要脚本功能时创建空文件，加载时不执行任何操作。有脚本功能时导出 `activate(api)`；模块必须自包含，不依赖运行时 JSX 编译，不导入应用内部模块，也不打包第二份 React：

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

## 数字形象事件与自定义角色

`api.avatar` 是公开的前端呈现接口，版本为 1。默认机器人与皮肤角色消费同一份状态；会话、语音播放和摄像头仍由宿主负责。皮肤可以替换为其他角色，自行映射骨骼、图片、SVG 或 Canvas，不需要复制聊天实现。

- `avatar.register({id, render})`：每个皮肤注册一个 React 形象组件，接收 `{state, name}`，返回注销函数。组件替换首页形象区域；渲染失败自动恢复默认机器人。停用脚本恢复原形象，不重建会话和草稿。
- `avatar.get(scope?)`：读取当前挂载形象的最新快照，没有形象时返回 `null`。`scope` 为 `{projectId, sessionId}`，省略时读取最近注册的形象。
- `avatar.subscribe(listener, scope?)`：订阅 `{type, scope, state, previous}`，返回取消订阅函数，停用皮肤自动清理。`type` 为 `state/audio/dispose`；关闭形象时 `state=null`。先订阅、再 `get` 可补齐初始状态。
- `avatar.motion`：`smoothstep(t)`、`damp(current,target,deltaMs,halfLifeMs)` 和 `createMotionMixer(initialNumbers)`。混合器 `sample(targetNumbers, clipKey, performance.now(), durationMs)` 按时间过渡；动作标识变化时从当前显示姿态继续，可中途打断。向量维度保持一致；减少动态效果时传入时长 0。组件自行清理 RAF／计时器。

快照字段：

| 字段 | 含义 |
| --- | --- |
| `version / projectId / sessionId` | 协议版本与所属会话 |
| `phase` | `idle/listening/thinking/working/replying/speaking` |
| `action` | `rest/listen/raise-hand/work/lower-hand`，角色可自行解释为相应动作 |
| `hands` | `lowered/raised/working`，表达目标姿态，不代表已经完成过渡 |
| `activityId / sequence` | 当前活动标识与语义变化序号；文本分块和音量变化不会重新启动同一动作 |
| `speech.playing / speech.level` | 真实播音状态、0–1 音量；未播音时音量为 0，文本回复不会点亮嘴部 |
| `emotion / intensity` | 当前情绪与 0–1 强度 |
| `affinity` | 0–100 好感度；没有真实记录时为 `null`，只读 |
| `reducedMotion` | 系统减少动态效果偏好 |
| `transition` | `{from,to,startedAt,durationMs,easing:'smoothstep',interruptible:true}`；时间基准为 `performance.now()` |

动作字段表达目标语义：思考托下巴、工作专注、回复／播音放下手。当前默认形象使用完整待机图与托下巴图切换，停用会拉扯手指和拆开关节的网格蒙皮；尚未完成真正的骨骼抬手／放手过渡，`transition` 不代表默认角色已经具备该动画。皮肤仍可通过同一状态与混合工具实现自己的骨骼动作。只有真实播音驱动嘴灯和舞台后的双层流光，停止后流光按时间衰减并停止绘制；音频帧不会重新触发动作。关节灯慢速呼吸、眼睛间歇闪动，胸口灯随真实好感度由青向红变化；减少动态效果时停止呼吸、眨眼与流光。隐藏、离屏、停用或卸载时暂停／清理绘制资源。

以下 `theme.js` 可直接注册另一种形象（资源由皮肤包提供）：

```js
export function activate(api) {
  const { createElement: h } = api.React
  function Character({ state, name }) {
    const duration = state.reducedMotion ? 0 : state.transition.durationMs
    return h('div', { className: 'my-character', role: 'img', 'aria-label': name },
      h('img', { src: api.asset('assets/character.webp'), alt: '',
        style: { width: '100%', height: '100%', objectFit: 'contain' } }),
      h('span', { className: 'my-character-hand', style: {
        transform: `rotate(${state.hands === 'raised' ? -35 : 0}deg)`,
        transition: `transform ${duration}ms ease-in-out`
      } }),
      h('span', { className: 'my-character-mouth', style: {
        opacity: state.speech.playing ? .25 + .75 * state.speech.level : 0
      } }))
  }
  return api.avatar.register({ id: 'my-character', render: Character })
}
```

在 `theme.css` 定义角色部件位置、尺寸和变换原点。角色容器应填满可用区域，不能使用屏幕固定尺寸；可在眼睛位置放一个 `data-avatar-eyes` 标记供共享摄像头预览定位。稳定宿主选择器为 `[data-ui="avatar"]`，带 `data-avatar-phase` 和 `data-avatar-action`。

需要在 SDK 外观察时，可监听 `window` 的 `workstep:avatar-state`（语义变化和关闭）与 `workstep:avatar-audio`（播音／音量变化）CustomEvent，`event.detail` 与上述事件结构相同；自行按项目和会话过滤，并用 AbortSignal 清理。快照只读，不包含消息正文、音频或摄像头数据。推荐皮肤使用 SDK，其订阅随皮肤生命周期自动释放；沿用现有「运行皮肤脚本」开关。

行为测试：`avatarRuntime.test.ts`、`avatarSkinHost.test.tsx`、`skinExtensions.test.ts`；真实 WebGL 动作与可中断过渡验收见 `scripts/check-digital-person-motion.mjs`。

## 存储与生命周期

IndexedDB 数据按当前身份／设备作用域、皮肤 ID 和功能 ID 隔离。`get/set/delete/list` 均异步；数据为 JSON。`export()` 返回 `{format:"workstep-feature-data",version:1,entries:[...]}`，`import(backup)` 在单个事务中替换当前功能数据；失败不部分写入。存储错误必须显示，不能把内存中的值称为“已保存”。

升级版本、切换或删除皮肤不自动删除功能数据。皮肤 ZIP 不包含用户数据；浏览器、设备或不同访问地址／端口之间不自动同步，清理浏览器存储会清除这些数据。功能应提供单独的备份入口。

脚本由设置 → 外观 → 选中皮肤 →「运行皮肤脚本」开关控制；检测到脚本时开关可用，无脚本时禁用并说明。直接切换、立即生效，无额外授权弹窗。开关按当前身份、设备访问范围和皮肤 ID 保存在浏览器，刷新、重新加载及同名皮肤更新后沿用；停用立即清理组件、动作和订阅。脚本加载失败时停用脚本并提示错误，保留已选皮肤外观。代码与当前页面拥有相同权限，SDK 是复用接口，不是安全沙箱。缩略图不运行代码；全站预览经启用后可运行，取消只恢复界面，不撤销已经执行的业务操作。注册的组件、动作和订阅随停用清理，渲染错误隔离在组件内。

v2 页面提供恢复默认入口；无法操作时，在页面 URL 加上 `skin=default` 后刷新，启动阶段会跳过自定义包和代码。

## 安装与验证

通过现有 `workstep skin validate <绝对目录> --json` 校验，再用 `workstep skin register <绝对目录> --json` 安装，或在设置 → 外观的高级包入口校验和注册。更新同名包使用 `--replace`。然后预览并应用；脚本通过外观页的「运行皮肤脚本」开关启用。格式校验不代表实际界面已通过视觉验收。

组件由皮肤作者按上述 SDK 创建并随皮肤包提供，应用不附带日历等示例功能。通用行为测试位于 `apps/web/tests/skinExtensions.test.ts` 和 `skinExtensionHost.test.tsx`，覆盖本地存储、启用、切换清理和失败恢复。
