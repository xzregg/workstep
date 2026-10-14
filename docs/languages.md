# Runtime 语言包

设置→外观同时提供字体、四档字号、语言和皮肤。点击“聊聊外观怎么改”，在原普通对话中要求增加语言，例如“帮我增加西班牙语，保留当前外观”。Runtime 根目录由配置决定，通常为 `$WORKSTEP_CONFIG_DIR/runtime/workspace`；建议语言草稿目录 `language/` 只是包路径，不会另建项目或助手。

右侧“语言”分区在对话轮次结束后自动读取草稿，也可指定任意绝对包目录，查看覆盖统计、完整缺失项和示例文案。安装并预览后，用固定中文恢复栏确认使用或取消；取消恢复原语言。安装不修改皮肤或字体；外观语言下拉框动态列出已安装包。刷新按钮刷新皮肤和语言目录。ZIP 的导入、导出、移除位于语言分区。项目绑定远程访问只允许读取选用已安装包，管理与草稿读取需要宿主权限。

## 包规范 v1

只允许 `manifest.json`、`messages.json` 和可选 `glossary.json`。manifest 必须恰好包含：

```json
{"schema_version":1,"id":"community-es-es","locale":"es-ES","name":"西班牙语","native_name":"Español","version":"1.0.0","fallback_locale":"en-US","direction":"ltr","catalog_revision":"<规范中的 revision>"}
```

messages 是扁平键到非空翻译的 JSON 字典。通过 `workstep language contract --json` 或 Runtime `language-contract.json` 获取真实键与原文；`required_keys` 的确认、取消、授权、允许、拒绝文案必须提供。其他未翻译项按“语言包→指定内置回退→简体中文→键”查找。占位符名称和重复次数必须一致；未知键、重复 JSON 键、HTML、脚本、链接文件、目录穿越、超量 ZIP 被拒绝。内置四种语言不可覆盖或删除。可选术语表供模型参考，不执行、不直接渲染。

## 安装和恢复

- `workstep language validate /absolute/package --json`：只校验，不安装。
- `workstep language register /absolute/package --json`：生成不可变快照并原子登记；更新明确加 `--replace`。
- `workstep language list|contract --json`：读取目录或规范。
- `workstep language export <id> --output /absolute/package.zip --json`：导出 ZIP。
- `workstep language delete <id> --json`：移除注册；当前语言回到内置回退。

前端只在下载与校验完成后切换，失败保留原语言。预览不持久化，确认后保存当前快照。选中包被移除时刷新回到内置回退；损坏缓存回退内置。设备语言包和制作记录共用，已认证网关用户的语言选择与皮肤、字体、字号一起按用户＋设备保存到设备后台，换浏览器访问恢复相同选择；本机未登录平台时沿用浏览器偏好。个人缓存不继承公共旧缓存；身份读取失败时回到默认界面，可在外观页重试。URL `?language=default` 可恢复并保存简体中文。接口及边界见 [动态皮肤](skins.md#注册预览和存储)。

## 当前范围

仅支持 ltr；未实现完整 RTL。第三方日期选择器沿用声明的内置回退语言，其他应用文案和 Intl 日期格式可使用新语言。覆盖数表示已提供的文案数，不保证翻译质量；历史消息、模型回复、工具输出、用户文件不自动翻译。语言元数据与术语修改通过现有聊天完成，没有独立语言中心或额外表单编辑器。包替换需显式确认，草稿自身不由语言编辑栏写回。
