"""Add rich mock data for all stages of the first task."""
import sys, json, time, uuid
sys.path.insert(0, '.')
from services.project import project_manager
from models import Task, TaskStep, Message

project_manager.register('/Users/xzr/Desktop/test_workstep')
project_manager.bind_project('/Users/xzr/Desktop/test_workstep')

# Read actual step keys from steps.json
proj = project_manager.get_project('/Users/xzr/Desktop/test_workstep')
steps_data = proj.steps
if steps_data.get('nodes'):
    step_keys = [n.get('type') for n in steps_data['nodes']]
else:
    step_keys = [s.get('key') for s in steps_data.get('steps', [])]

print(f"Step keys from steps.json: {step_keys}")

now = int(time.time())
tasks = list(Task.select().order_by(Task.created_at))
task = tasks[0]
print(f"Task: {task.title} (id={task.id})")

# Ensure all task steps exist
for sk in step_keys:
    TaskStep.get_or_create(task=task, step_key=sk, defaults={'status': 'pending'})

# Rich mock data mapped by step key
stage_messages = {
    'req': [
        ('user', '帮我优化用户注册流程，当前转化率太低了，大概只有23%'),
        ('assistant', '好的，我来分析当前的注册流程。\n\n让我先看看现有的注册页面代码和用户行为数据...'),
        ('assistant', '## 当前问题分析\n\n1. **步骤过多**: 5步注册，每步流失约15%\n2. **验证延迟**: 提交后才验证\n3. **缺少引导**: 没有进度提示\n4. **密码要求过高**: 8位+大小写+特殊字符\n\n## 优化方案\n\n### 方案A: 精简步骤 (5→3步)\n- 合并手机号+密码\n- 社交登录可选\n\n### 方案B: 增强体验\n- 实时字段验证\n- 顶部进度条\n- 密码强度实时显示\n\n建议都做，预计转化率提升至40%+'),
        ('user', '方案A和B都做，先出PRD文档'),
        ('assistant', '收到，开始撰写PRD文档。\n\n# 用户注册流程优化 PRD\n\n## 1. 背景\n当前转化率23%，行业平均35%。主要流失在步骤3(密码,28%)和步骤4(个人信息,22%)。\n\n## 2. 目标\n- 转化率 > 40%\n- 注册时长 < 2分钟\n- 满意度 > 4.2\n\n## 3. 功能需求\n\n### 3.1 精简注册 (5→3步)\n| 步骤 | 内容 | 耗时 |\n|------|------|------|\n| 1 | 手机号/邮箱+密码 | 30s |\n| 2 | 验证码+社交登录 | 20s |\n| 3 | 个人信息(可选) | 30s |\n\n### 3.2 实时验证\n- 手机号格式校验\n- 密码强度显示\n- 邮箱重复检查\n- 反馈 < 500ms\n\n### 3.3 进度指示器\n- 步骤 X/3\n- 进度条动画\n\n### 3.4 社交登录\n- 微信 / 支付宝 / Apple ID\n\n## 4. 验收标准\n- [ ] 步骤 ≤ 3\n- [ ] 验证反馈 < 500ms\n- [ ] 社交登录成功率 > 95%'),
    ],
    'ui': [
        ('user', 'PRD确认通过，开始设计UI'),
        ('assistant', '好的，根据PRD开始UI设计。\n\n## 设计思路\n\n### 风格\n- 简洁现代，白色为主\n- 主色: #0071E3\n- 圆角: 8px\n- 字体: SF Pro\n\n### 页面结构\n\n**Step 1: 账号设置**\n- 手机号/邮箱切换tab\n- 密码输入(带强度指示)\n- 下一步按钮\n\n**Step 2: 验证 & 社交登录**\n- 6位验证码\n- 分割线「── 或 ──」\n- 微信/支付宝/Apple按钮\n\n**Step 3: 个人信息(可跳过)**\n- 昵称 + 头像\n- 完成/跳过按钮'),
        ('assistant', '## 组件规范\n\n### 进度条\n- 高4px, 背景#E5E5E7, 填充#0071E3\n- 动画: ease-in-out 300ms\n\n### 输入框状态\n| 状态 | 边框 | 图标 |\n|------|------|------|\n| 默认 | #E5E5E7 | - |\n| 聚焦 | #0071E3 | - |\n| 成功 | #16A34A | ✓ |\n| 失败 | #DC2626 | ✕ |\n\n### 密码强度\n- 弱: 红(1格)\n- 中: 黄(2格)\n- 强: 绿(3格)\n\n设计稿已输出，含3个页面+组件库。'),
    ],
    'frontend': [
        ('user', '设计稿确认，开始前端开发'),
        ('assistant', '收到，开始前端开发。\n\n## 技术方案\n- React 18 + TypeScript\n- Zustand 状态管理\n- react-hook-form + zod\n- Tailwind CSS\n- Vitest 测试\n\n## 文件结构\n```\nsrc/pages/Register/\n  index.tsx\n  Step1Account.tsx\n  Step2Verify.tsx\n  Step3Profile.tsx\n  ProgressBar.tsx\nsrc/stores/registerStore.ts\nsrc/hooks/useValidation.ts\n```'),
        ('assistant', '## 开发完成 ✅\n\n- [x] 注册主页面\n- [x] Step1: 账号设置\n- [x] Step2: 验证码+社交登录\n- [x] Step3: 个人信息\n- [x] 进度条组件\n- [x] 密码强度指示器\n- [x] 实时验证\n- [x] Zustand store\n- [x] 单元测试(覆盖率87%)\n\n产出: 前端页面 + store + 测试'),
    ],
    'backend': [
        ('user', '前端OK，开始后端开发'),
        ('assistant', '收到，开始后端API开发。\n\n## 接口设计\n\nPOST /api/auth/register\nPOST /api/auth/send-code\nPOST /api/auth/verify-code\nPOST /api/auth/social-login\n\n## 数据库\n- users表: id, phone, email, password_hash, nickname\n- verification_codes表: code, phone, expire_at\n\n## 安全措施\n- bcrypt加密(cost=12)\n- JWT(7天有效期)\n- Redis频率限制(10次/分)'),
        ('assistant', '## 后端完成 ✅\n\n- [x] 注册接口\n- [x] 验证码发送/校验\n- [x] 社交登录\n- [x] 密码加密(bcrypt)\n- [x] JWT Token\n- [x] 频率限制(Redis)\n- [x] 单元测试(覆盖率92%)\n\n产出: API服务 + 数据库 + 测试'),
    ],
    'test': [
        ('user', '前后端都完成了，开始集成测试'),
        ('assistant', '收到，开始集成测试。\n\n## 测试计划\n- 正常注册(3步)\n- 社交登录\n- 手机号重复\n- 验证码过期\n- 密码强度不足\n\n工具: k6压测 + Cypress E2E'),
        ('assistant', '## 测试结果 ✅\n\n| 场景 | 结果 | 耗时 |\n|------|------|------|\n| 正常注册 | ✅ | 1.8s |\n| 社交登录 | ✅ | 2.1s |\n| 手机号重复 | ✅ | 0.3s |\n| 验证码过期 | ✅ | 0.2s |\n\n性能: P99=156ms, QPS=623, 错误率0.03%\nE2E: 15场景全部通过\n\nBug:\n- BUG-001: 验证码60s内可重发(P2,已修)\n- BUG-002: 昵称特殊字符(P3,已修)\n\n产出: 测试报告 + Bug列表'),
    ],
    'deploy': [
        ('user', '测试通过，准备上线'),
        ('assistant', '收到，开始部署。\n\n## 部署计划\n- 3台ECS(4C8G)\n- SLB负载均衡\n- RDS MySQL主从\n- Redis Cluster\n- 灰度: 10%→50%→100%'),
        ('assistant', '## 部署完成 ✅\n\n| 步骤 | 状态 | 耗时 |\n|------|------|------|\n| 数据库迁移 | ✅ | 12s |\n| Redis配置 | ✅ | 3s |\n| 后端更新 | ✅ | 45s |\n| CDN发布 | ✅ | 8s |\n| 灰度10% | ✅ | 5min |\n| 全量发布 | ✅ | 5min |\n\n监控: 错误率0.02%, P99=142ms\n注册转化率: 43% (目标40% ✅)\n\n部署完成，指标正常！'),
    ],
}

# Clear existing messages for this task
Message.delete().where(Message.task == task).execute()

# Insert messages for each stage
pos = 1
for sk in step_keys:
    msgs = stage_messages.get(sk, [])
    base_time = now - (len(step_keys) - step_keys.index(sk)) * 3600
    for i, (role, content) in enumerate(msgs):
        created_at = base_time + i * 120
        events = [
            {'type': 'text_delta', 'data': {'delta': content[:80]}, 'timestamp': created_at * 1000},
            {'type': 'usage', 'data': {'input_tokens': 600, 'output_tokens': len(content)}, 'timestamp': (created_at + 30) * 1000},
        ]
        Message.create(
            id=str(uuid.uuid4()),
            task=task, step_key=sk, role=role,
            content=content, run_status='succeeded',
            events_json=json.dumps(events),
            position=pos, created_at=created_at,
        )
        pos += 1
    print(f"  {sk}: {len(msgs)} messages")

# Update step statuses
for sk in step_keys[:-1]:  # All except last
    TaskStep.update(status='passed').where((TaskStep.task == task) & (TaskStep.step_key == sk)).execute()
if step_keys:
    TaskStep.update(status='running').where((TaskStep.task == task) & (TaskStep.step_key == step_keys[-1])).execute()

total = Message.select().where(Message.task == task).count()
print(f"\nTotal: {total} messages across {len(step_keys)} stages")
print("Done!")
