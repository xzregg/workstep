"""Project UI visibility only; existing bridge authorization remains unchanged."""
import json
from typing import Literal
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from gateway.models import ProjectAccessGrant
from gateway.services.permission_subjects import active_group_ids
from gateway.services.identity import IdentityService

# Stable keys are shared by the admin catalog and Web visibility checks.
GROUPS = {
    '任务': {
        'task.read': ('查看任务', '列表、进度、日志和结果'),
        'task.create': ('创建任务', '使用已有流程提交需求'),
        'task.copy': ('复制任务', '复制已有任务'),
        'task.ai_create': ('AI 创建任务', '使用任务草稿助手'),
        'task.start_on_create': ('创建时自动执行', '提交后立即启动'),
        'task.schedule_start': ('预约启动', '预约或修改启动时间'),
        'task.edit': ('修改任务', '修改标题与描述'),
        'task.delete': ('删除任务', '删除已有任务'),
        'task.archive': ('归档任务', '归档与取消归档'),
        'task.run': ('执行任务', '启动任务'),
        'task.stop': ('暂停或取消', '停止任务和步骤'),
        'task.restart': ('恢复与重启', '恢复步骤和重试消息'),
        'task.chat': ('任务内交流', '补充需求与任务对话'),
        'task.review': ('人工审核', '通过、驳回和完成步骤'),
        'task.config': ('修改执行配置', '引擎、模型及协调助手配置'),
        'task.proposal_apply': ('应用助手提案', '确认补充步骤或重跑提案'),
    },
    '流程': {
        'workflow.read': ('查看流程', '查看已有流程和步骤'),
        'workflow.create': ('创建流程', '新建流程和使用模板'),
        'workflow.edit': ('编辑流程步骤', '步骤、连线、提示词及规则'),
        'workflow.delete': ('删除流程', '删除已有流程'),
        'workflow.ai_edit': ('AI 流程助手', '生成并应用流程方案'),
        'workflow.hooks': ('管理流程钩子', '配置触发和通知钩子'),
    },
    '项目会话': {
        'session.read': ('查看项目会话', '会话列表和历史消息'),
        'session.create': ('创建项目会话', '新建、分叉和交接'),
        'session.chat': ('项目对话', '发送消息及停止回复'),
        'session.manage': ('管理项目会话', '重命名、归档和删除'),
        'session.config': ('配置项目会话', '提示词、快捷按钮和权限模式'),
    },
    '文件': {
        'file.read': ('查看文件', '目录浏览、预览和下载'),
        'file.upload': ('上传文件', '上传文件、图片和附件'),
        'file.edit': ('编辑文件', '修改内容和项目记忆'),
        'file.manage': ('管理文件目录', '新建、移动、重命名和删除'),
    },
    'Git': {
        'git.read': ('查看 Git', '状态、历史和差异'),
        'git.workspace': ('管理 Git 工作区', '创建和删除工作树'),
        'git.write': ('Git 本地操作', '提交、分支、合并和恢复'),
        'git.remote': ('Git 远端操作', '获取、拉取和推送'),
        'git.config': ('Git 配置', '修改仓库身份配置'),
    },
    '其他': {
        'schedule.read': ('查看定时任务', '配置和执行记录'),
        'schedule.manage': ('管理定时任务', '创建、修改、删除及启停'),
        'share.create': ('创建分享', '创建任务分享'),
        'share.manage': ('管理分享', '修改和撤销分享'),
        'statistics.read': ('查看统计', '用量和执行报告'),
        'project.settings': ('修改项目设置', '执行和并发配置'),
        'action.run': ('运行快捷操作', '执行及停止快捷按钮'),
        'action.manage': ('管理快捷操作', '配置快捷按钮'),
        'skill.read': ('查看项目 Skills', '查看技能列表'),
        'skill.manage': ('管理项目 Skills', '修改技能和重新扫描'),
    },
}
KEYS = {key for group in GROUPS.values() for key in group}
READ_KEYS = {key for key in KEYS if key.endswith('.read')}
SETS = [
    {'id': 'viewer', 'name': '只读查看者', 'description': '查看任务、流程和结果', 'permissions': ['task.read', 'workflow.read']},
    {'id': 'creator', 'name': '任务创建者', 'description': '使用已有流程提交任务', 'permissions': ['task.read', 'workflow.read', 'task.create']},
    {'id': 'collaborator', 'name': '任务协作者', 'description': '创建、交流和跟进任务', 'permissions': ['task.read', 'workflow.read', 'task.create', 'task.edit', 'task.chat', 'task.run', 'task.stop', 'task.restart']},
    {'id': 'editor', 'name': '项目编辑者', 'description': '项目业务操作，分享另授权', 'permissions': sorted(KEYS - {'share.create', 'share.manage'})},
]


def project_ui_catalog():
    return {'project_permissions': [{'id': key, 'name': value[0], 'description': value[1], 'category': category}
            for category, items in GROUPS.items() for key, value in items.items()],
            'project_permission_sets': SETS}


class UiPermissions(BaseModel):
    allow: list[str] = Field(default_factory=list, max_length=100)
    deny: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode='after')
    def valid_keys(self):
        if (set(self.allow) | set(self.deny)) - KEYS:
            raise ValueError('Unknown project permission')
        if set(self.allow) & set(self.deny):
            raise ValueError('A permission cannot be allowed and denied together')
        self.allow, self.deny = sorted(set(self.allow)), sorted(set(self.deny))
        return self


class ProjectPermissionSetInput(UiPermissions):
    subject_type: Literal['user', 'group']
    subject_id: str = Field(min_length=1, max_length=64)
    project_id: str = Field(min_length=1, max_length=64)


async def set_project_permission_set(call, body: ProjectPermissionSetInput):
    from gateway.services.identity_api import _super_admin_request
    from gateway.services.identity import COOKIE_NAME
    from gateway.services.project_access_api import ProjectGrantInput, set_project_grant
    identity, _ = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    policy = UiPermissions(allow=body.allow, deny=body.deny)
    level = 'edit' if set(body.allow) - READ_KEYS else 'read'
    result = await set_project_grant(call, body.project_id, ProjectGrantInput(
        subject_type=body.subject_type, subject_id=body.subject_id, access_level=level,
        ui_permissions=policy))
    return {'id': f"project:{result['id']}"}


async def effective_ui_permissions(session, user_id, project_id):
    if await IdentityService.super_admin_in_session(session, user_id):
        return sorted(KEYS)
    group_ids = set((await session.scalars(active_group_ids(user_id))).all())
    grants = (await session.scalars(select(ProjectAccessGrant).where(
        ProjectAccessGrant.project_id == project_id, ProjectAccessGrant.revoked_at.is_(None)))).all()
    allowed, denied = set(), set()
    for row in grants:
        if not ((row.subject_type == 'user' and row.subject_id == user_id)
                or (row.subject_type == 'group' and row.subject_id in group_ids)):
            continue
        if row.ui_permissions_json is None:
            allowed.update(KEYS if row.access_level == 'edit' else READ_KEYS)
        else:
            policy = json.loads(row.ui_permissions_json)
            allowed.update(policy['allow'])
            denied.update(policy['deny'])
    return sorted((allowed - denied) & KEYS)


async def sync_business_capabilities(session, actor_id, subject_type, subject_id, project_id, policy):
    """Persist the two existing project-scoped business grants atomically with the UI policy."""
    from datetime import datetime, timezone
    from uuid import uuid4
    from gateway.models import CapabilityAssignment, GroupCapabilityAssignment
    from gateway.services.capabilities import _bump_revisions, bump_group_capability_revisions
    for capability in ('task.create', 'share.create'):
        if subject_type == 'group':
            model = GroupCapabilityAssignment
            conditions = (model.group_id == subject_id, model.project_id == project_id)
            values = {'group_id': subject_id, 'project_id': project_id}
        else:
            model = CapabilityAssignment
            conditions = (model.user_id == subject_id, model.scope_type == 'project', model.scope_id == project_id)
            values = {'user_id': subject_id, 'scope_type': 'project', 'scope_id': project_id}
        row = await session.scalar(select(model).where(*conditions, model.capability == capability))
        related = {'task.create', 'task.copy', 'task.ai_create', 'task.start_on_create'} if capability == 'task.create' else {'share.create', 'share.manage'}
        effect = 'deny' if capability in policy.deny else 'allow' if related.intersection(policy.allow) else None
        if effect:
            if row is None:
                session.add(model(id=str(uuid4()), capability=capability, effect=effect, assigned_by_user_id=actor_id, **values))
            else:
                row.effect, row.revoked_at, row.assigned_by_user_id = effect, None, actor_id
        elif row is not None:
            row.revoked_at = datetime.now(timezone.utc)
    if subject_type == 'group':
        await bump_group_capability_revisions(session, subject_id)
    else:
        await _bump_revisions(session, subject_id, 'project', project_id)
