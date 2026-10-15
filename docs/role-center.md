# 角色中心

入口为 **设置 → 角色中心**，分别管理角色库和专家团。当前阶段只保存提示词资产，尚未接入任务步骤、聊天召唤或引擎执行。

## 全局文件存储

沿用流程模板的存储模式，数据跟随 `WORKSTEP_CONFIG_DIR`，默认目录为：

```text
~/.workstep/data/role-center/
  categories.json                 # 分类名称
  source.json                     # 内置来源快照
  LICENSE.agency-agents.txt        # 原始 MIT 许可证
  roles/<角色ID>.json              # 名称、分类、简介、Markdown 提示词、来源
  teams/<专家团ID>.json            # 名称、用途、团级提示词、有序成员与分工
```

应用携带 `apps/daemon/data/role-center/` 内置数据，daemon 启动时只复制缺失文件。现有文件不被覆盖，内置角色可以编辑，自定义角色与专家团随重启保留。保存使用同目录临时文件与原子替换；编辑提交当前文件摘要，文件已被其他窗口或外部编辑器改动时返回冲突，不覆盖新内容。JSON 文件须保持既有结构，路径不接受符号链接。

角色中心属于设备全局资产。HTTP 接口沿用宿主管理门禁，项目范围的远程访问票据不能管理全局角色中心；当前没有新增网关项目范围代理协议或设备下发功能。

## 内置来源

导入 [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) 的固定提交 `bd956db032d907387e6b9ddebff3e18f1de8c679`，共 **282 个角色、18 个分类**。分类取自上游 `divisions.json`，只统计分类目录中有角色前言的 Markdown 文件，不含集成导出副本、示例与团队运行手册。

角色名称、简介和提示词保留上游原文，分类显示中文名称。提示词为原角色 Markdown 正文；来源中保留仓库、文件路径、提交号和 MIT 许可证标识，原始许可证随资产分发。角色 ID 根据来源文件路径稳定生成。应用运行时不联网同步上游。

## 角色与专家团

- 角色定义专业身份、工作方法和交付要求。
- 专家团的成员按顺序保存 `role_id` 与 `duty`，同一角色不能重复加入同一团。专家团可以自行组合内置或自定义角色。
- 专家团另存 `prompt`，用于共同目标、先后顺序、交接与汇总约定；可以留空。
- 专家团不复制成员的角色提示词。修改角色后，团队引用同一角色；团级约定不会改变该角色在其他团队里的定义。
- 当前保存的成员顺序和团级提示词仅是资产信息，并未实现执行调度。

## API 与验证

`GET /api/role-center` 返回分类、角色摘要、团队摘要和无法读取的文件提示，不返回全部角色的长提示词。

角色与专家团分别使用 `/api/role-center/roles`、`/api/role-center/teams` 的 POST 新增，`/{id}` 的 GET 读取完整内容及 PUT 编辑。PUT 要求 `expected_revision`，角色来源与内置标记不能由编辑请求修改。

后端测试为 `apps/daemon/tests/test_role_center.py`：内置清单完整性、保存与重启、重新初始化保留修改、团队引用和分工、旧版本冲突、路径校验、原子写失败恢复、项目作用域拒绝，以及慢盘下真实 API 健康检查。

前端行为测试为 `apps/web/tests/roleCenter.test.tsx`，覆盖分类搜索、角色编辑、新增校验、保存失败恢复、未保存关闭保护、读取重试，以及团队提示词、成员分工和顺序。设置入口测试为 `settingsNavigation.test.tsx`；Markdown 提示词编辑复用公共 `MarkdownEditor`，不显示项目附件入口。
