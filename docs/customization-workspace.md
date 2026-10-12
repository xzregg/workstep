# Runtime 创作项目

技能、引擎和皮肤制作复用一个固定的普通项目，显示名称为 `Runtime`。默认根目录为 `$WORKSTEP_CONFIG_DIR/runtime/workspace/`，默认配置目录是 `~/.workstep`；设置 `WORKSTEP_PROJECTS_ROOT` 时使用允许项目根下的 `runtime/`。

Daemon 启动时准备默认工作区，之后复用相同项目 ID 和数据库，每次制作入口仅新建普通会话。项目摘要通过实际固定路径标记 `is_default_workspace`，不靠名称识别。没有选中项目时前端选中 Runtime，首页进入普通对话；已有项目选择及远程授权项目优先。系统不按类型、会话或草稿 ID 分配目录。引擎、技能与皮肤文件由对话在这个项目根目录里按需要创建；具体包名和目录名不由工作区基础设施规定。

`services/customization_workspace.py::runtime_project` 在线程内串行首次初始化，创建会话仍走项目数据库执行器。重启后从 `.workstep/project.json` 恢复相同身份，不增加助手类型。

皮肤入口提供根目录中的 `skin-contract.json`，但不提前创建皮肤包。右侧先显示内存中的起始样式，可选择颜色和布局；明确保存微调后才在 Runtime 内创建包，已有目录不会被覆盖。右侧默认读取 `<根目录>/skin/`；对话可以另取包名，用户在右侧「皮肤包目录」读取实际包。包尚未生成时仍可正常聊天，对话生成完成后自动读取；手动微调和对话修改共用同一包。

技能入口为本机项目设置 → 技能 →「聊天制作技能」，或 `workstep skill create --json`。宿主 API 为 POST `/api/skills/onboarding`，返回固定根目录、项目和新会话及启动提示，前端打开既有项目对话。引擎和皮肤入口也返回同一个工作目录。项目授权用户不能创建宿主制作会话。

**仅统一创作工作目录。** 已安装技能来源 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、现有技能镜像以及正式引擎／皮肤安装目录均不迁移。Runtime 根目录不是技能扫描根，制作中的技能不自动安装或启用；用户明确要求安装后才使用原有安装方式。

旧制作项目、目录和会话保留，不自动搬迁或删除。

测试：`test_customization_workspace.py` 验证三个入口并发复用、无自动类型目录、不同普通会话、重启身份和技能不被自动加载；`test_skill_onboarding.py` 覆盖真实 API、慢 SQL 健康检查和项目授权拒绝。原引擎／皮肤 onboarding 测试继续覆盖目录边界及普通会话；前端 `skillDraftCreate.test.tsx` 和 `skinStudio.test.tsx` 验证普通对话及包读取微调。
