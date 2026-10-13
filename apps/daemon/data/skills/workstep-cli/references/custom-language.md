# Runtime 语言包

沿用默认工作区与外观对话，不创建助手或新的项目。调用 `workstep language contract --json` 获取真实扁平文案、revision 与 required_keys；规范也会写到 Runtime 根目录的 language-contract.json。

包内只放 manifest.json、messages.json 和可选 glossary.json。manifest 字段：schema_version=1、id、locale（例如 es-ES）、name、native_name、version、fallback_locale（内置四种语言之一）、direction=ltr、catalog_revision。messages 为键到翻译的扁平字典。禁止覆盖内置语言、HTML、脚本、未知键和修改占位符；required_keys 必须提供，其他文案可回退。只翻译指定范围时如实说明覆盖率。

`workstep language validate /absolute/package --json` 校验；用户确认后 `workstep language register /absolute/package --json`，替换需 --replace。右侧语言分区可读取覆盖率、预览、安装、导入/导出 ZIP、移除；设置→外观的语言下拉框动态显示安装包，确认使用后无需重启。第三方日期控件沿用内置回退语言，暂不支持 RTL。
