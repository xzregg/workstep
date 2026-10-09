"""One administrative boundary for permission assignments to users and groups."""
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, or_, select

from gateway.models import (AdminAssignment, AuditEvent, CapabilityAssignment, Device,
                            DeviceGroup, DirectoryDepartment, GroupCapabilityAssignment, GroupDevice,
                            IdentitySource, PlatformProject, PlatformProvider, ProjectAccessGrant,
                            ProviderAssignment, User, UserDevice, UserGroup)
from gateway.services.capabilities import _bump_revisions, bump_group_capability_revisions
from gateway.services.errors import GatewayError
from gateway.services.identity import COOKIE_NAME, _now
from gateway.services.identity_api import _super_admin_read, _super_admin_request

CATALOG = {
    "device.access": ("访问整台设备", "资源访问", ("device",)),
    "project.read": ("查看项目", "资源访问", ("project",)),
    "project.edit": ("编辑项目", "资源访问", ("project",)),
    "provider.use": ("使用模型供应商", "资源访问", ("provider",)),
    "task.create": ("创建任务", "业务操作", ("global", "device", "project")),
    "project.publish": ("发布项目", "业务操作", ("global", "device")),
    "share.create": ("创建分享", "业务操作", ("global", "device", "project")),
    "engine.install": ("安装引擎", "业务操作", ("global", "device")),
    "provider.local": ("使用本地供应商", "业务操作", ("global", "device")),
    "admin.super_admin": ("超级管理员", "平台管理", ("platform",)),
    "admin.identity_admin": ("用户与身份管理", "平台管理", ("platform", "department")),
    "admin.org_admin": ("组织管理", "平台管理", ("platform", "organization")),
    "admin.department_admin": ("部门管理", "平台管理", ("department",)),
    "admin.device_admin": ("设备管理", "平台管理", ("platform", "device_group")),
    "admin.skill_admin": ("Skills 管理", "平台管理", ("platform",)),
    "admin.audit_admin": ("用量与审计查看", "平台管理", ("platform", "organization", "department", "device_group")),
}


def permission_effects(permission):
    return ["allow", "deny"] if permission in ("task.create", "project.publish", "share.create", "engine.install", "provider.local") else ["allow"]


class PermissionInput(BaseModel):
    subject_type: Literal["user", "group"]
    subject_id: str = Field(min_length=1, max_length=64)
    permission: str
    scope_type: str
    scope_id: str | None = Field(default=None, min_length=1, max_length=64)
    effect: Literal["allow", "deny"] = "allow"
    include_subdepartments: bool = True

    @model_validator(mode="after")
    def valid_permission(self):
        definition = CATALOG.get(self.permission)
        if not definition or self.scope_type not in definition[2]:
            raise ValueError("Invalid permission scope")
        if self.effect not in permission_effects(self.permission):
            raise ValueError("This permission supports grants and revocation")
        if (self.scope_type in ("global", "platform")) != (self.scope_id is None):
            raise ValueError("Invalid permission resource")
        return self


async def permission_catalog(call):
    await _super_admin_read(call)
    return {"permissions": [{"id": key, "name": value[0], "category": value[1],
                              "scopes": list(value[2]), "effects": permission_effects(key)}
                             for key, value in CATALOG.items()]}


async def permission_subjects(call, subject_type="user", q="", page=1, page_size=25):
    await _super_admin_read(call)
    model = User if subject_type == "user" else UserGroup
    conditions = [model.status == "active"]
    name = User.display_name if subject_type == "user" else UserGroup.name
    if q.strip():
        pattern = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        conditions.append(or_(name.ilike(pattern, escape="\\"), User.username.ilike(pattern, escape="\\"))
                          if subject_type == "user" else name.ilike(pattern, escape="\\"))
    async with call.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(model).where(*conditions))
        rows = (await session.scalars(select(model).where(*conditions).order_by(name, model.id)
                 .offset((page - 1) * page_size).limit(page_size))).all()
    return {"subjects": [{"id": row.id, "name": (row.display_name or row.username) if subject_type == "user" else row.name,
                           "username": row.username if subject_type == "user" else None} for row in rows], "total": total}


async def permission_resources(call, scope_type, q="", page=1, page_size=25):
    await _super_admin_read(call)
    models = {"device": Device, "project": PlatformProject, "provider": PlatformProvider,
              "device_group": DeviceGroup, "organization": IdentitySource, "department": DirectoryDepartment}
    model = models.get(scope_type)
    if model is None:
        raise GatewayError("invalid", "Invalid resource scope")
    name = DirectoryDepartment.display_name if model is DirectoryDepartment else IdentitySource.tenant_id if model is IdentitySource else model.name
    conditions = []
    if hasattr(model, "status"):
        conditions.append(model.status == "active")
    if hasattr(model, "enabled"):
        conditions.append(model.enabled == 1)
    if model is PlatformProject:
        conditions.append(model.access_mode == "remote_published")
    if model is DirectoryDepartment:
        from gateway.services.directory_departments import assignable_department
        conditions.append(assignable_department())
    if q.strip():
        pattern = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        conditions.append(name.ilike(pattern, escape="\\"))
    async with call.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(model).where(*conditions))
        rows = (await session.execute(select(model.id, name).where(*conditions).order_by(name, model.id)
                 .offset((page - 1) * page_size).limit(page_size))).all()
    return {"resources": [{"id": row[0], "name": row[1]} for row in rows], "total": total}


async def set_permission(call, body: PermissionInput):
    identity, actor = await _super_admin_request(call)
    _, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    if body.permission == "provider.use":
        from gateway.services.providers_api import ProviderAssignInput, assign_platform_provider
        result = await assign_platform_provider(call, body.scope_id, ProviderAssignInput(
            subject_type=body.subject_type, subject_id=body.subject_id))
        return {"id": f"provider:{result['id']}"}
    if body.permission == "device.access":
        from gateway.services.device_grants import DeviceGrantInput, set_device_grant
        result = await set_device_grant(call, body.scope_id, DeviceGrantInput(
            subject_type=body.subject_type, subject_id=body.subject_id))
        return {"id": f"device_{body.subject_type}:{result['id']}"}
    if body.permission in ("project.read", "project.edit"):
        from gateway.services.project_access_api import ProjectGrantInput, set_project_grant
        result = await set_project_grant(call, body.scope_id, ProjectGrantInput(
            subject_type=body.subject_type, subject_id=body.subject_id,
            access_level="edit" if body.permission == "project.edit" else "read"))
        return {"id": f"project:{result['id']}"}
    if body.permission.startswith("admin.") and body.subject_type == "user":
        row = await identity.grant_role(actor.id, body.subject_id, body.permission.removeprefix("admin."),
            body.scope_type, body.scope_id, body.include_subdepartments)
        return {"id": f"role:{row.id}"}
    async with call.database.session() as session:
        async with session.begin():
            subject = await session.get(User if body.subject_type == "user" else UserGroup, body.subject_id)
            if subject is None or subject.status != "active":
                raise GatewayError("not_found", "Permission subject unavailable")
            resources = {"device": Device, "project": PlatformProject, "device_group": DeviceGroup,
                         "organization": IdentitySource, "department": DirectoryDepartment}
            if body.scope_type in resources:
                resource = await session.get(resources[body.scope_type], body.scope_id)
                if not resource or (hasattr(resource, "status") and resource.status != "active"):
                    raise GatewayError("not_found", "Permission resource unavailable")
                if body.scope_type == "project" and resource.access_mode != "remote_published":
                    raise GatewayError("conflict", "Project is not published")
            if body.permission.startswith("admin."):
                role = body.permission.removeprefix("admin.")
                row = await session.scalar(select(AdminAssignment).where(
                    AdminAssignment.group_id == body.subject_id, AdminAssignment.role == role,
                    AdminAssignment.scope_type == body.scope_type,
                    AdminAssignment.scope_id == body.scope_id,
                    AdminAssignment.revoked_at.is_(None),
                ))
                if row is None:
                    row = AdminAssignment(id=str(uuid4()), group_id=body.subject_id, role=role,
                        scope_type=body.scope_type, scope_id=body.scope_id, granted_by_user_id=actor.id)
                    session.add(row)
                row.include_subdepartments = int(body.scope_type == "department" and body.include_subdepartments)
                await bump_group_capability_revisions(session, body.subject_id)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                    action="admin.permission_set", result="success", metadata_json=body.model_dump_json()))
                return {"id": f"role:{row.id}"}
            if body.subject_type == "group" and body.scope_type == "project":
                row = await session.scalar(select(GroupCapabilityAssignment).where(
                    GroupCapabilityAssignment.group_id == body.subject_id,
                    GroupCapabilityAssignment.project_id == body.scope_id,
                    GroupCapabilityAssignment.capability == body.permission))
                if row is None:
                    row = GroupCapabilityAssignment(id=str(uuid4()), group_id=body.subject_id,
                        project_id=body.scope_id, capability=body.permission,
                        effect=body.effect, assigned_by_user_id=actor.id)
                    session.add(row)
                else:
                    row.effect, row.revoked_at, row.assigned_by_user_id = body.effect, None, actor.id
                await bump_group_capability_revisions(session, body.subject_id)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                    action="admin.permission_set", result="success", metadata_json=body.model_dump_json()))
                return {"id": f"group_capability:{row.id}"}
            column = CapabilityAssignment.user_id if body.subject_type == "user" else CapabilityAssignment.group_id
            row = await session.scalar(select(CapabilityAssignment).where(
                column == body.subject_id, CapabilityAssignment.capability == body.permission,
                CapabilityAssignment.scope_type == body.scope_type,
                CapabilityAssignment.scope_id == (body.scope_id or ""),
            ))
            if row is None:
                row = CapabilityAssignment(id=str(uuid4()), capability=body.permission,
                    scope_type=body.scope_type, scope_id=body.scope_id or "",
                    **{f"{body.subject_type}_id": body.subject_id},
                    effect=body.effect, assigned_by_user_id=actor.id)
                session.add(row)
            else:
                row.effect, row.revoked_at, row.assigned_by_user_id = body.effect, None, actor.id
            if body.subject_type == "user":
                await _bump_revisions(session, body.subject_id, body.scope_type, body.scope_id or "")
            else:
                await bump_group_capability_revisions(session, body.subject_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                action="admin.permission_set", result="success", metadata_json=body.model_dump_json()))
    return {"id": f"capability:{row.id}"}


async def revoke_permission(call, assignment_id: str):
    identity, actor = await _super_admin_request(call)
    _, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    family, _, row_id = assignment_id.partition(":")
    model = {"role": AdminAssignment, "capability": CapabilityAssignment,
             "group_capability": GroupCapabilityAssignment, "project": ProjectAccessGrant,
             "device_user": UserDevice, "device_group": GroupDevice, "provider": ProviderAssignment}.get(family)
    if model is None or not row_id:
        raise GatewayError("not_found", "Permission assignment unavailable")
    if family in ("project", "device_user", "device_group", "provider"):
        async with call.database.session() as session:
            row = await session.get(model, row_id)
            if not row or row.revoked_at:
                raise GatewayError("not_found", "Permission assignment unavailable")
            if family == "provider":
                args = row.provider_id, row.subject_type, row.subject_id
            elif family == "project":
                args = row.project_id, row.subject_type, row.subject_id
            else:
                kind = "user" if family == "device_user" else "group"
                args = row.device_id, kind, row.user_id if kind == "user" else row.group_id
        if family == "provider":
            from gateway.services.providers_api import ProviderAssignInput, revoke_platform_provider_assignment
            await revoke_platform_provider_assignment(call, args[0], ProviderAssignInput(subject_type=args[1], subject_id=args[2]))
        elif family == "project":
            from gateway.services.project_access_api import revoke_project_grant
            await revoke_project_grant(call, *args)
        else:
            from gateway.services.device_grants import revoke_device_grant
            await revoke_device_grant(call, *args)
        return
    async with call.database.session() as session:
        async with session.begin():
            row = await session.get(model, row_id)
            if not row or row.revoked_at:
                raise GatewayError("not_found", "Permission assignment unavailable")
            if family == "role" and row.user_id:
                user_role = True
            else:
                user_role = False
                row.revoked_at = _now()
                if row.group_id:
                    await bump_group_capability_revisions(session, row.group_id)
                else:
                    await _bump_revisions(session, row.user_id, row.scope_type, row.scope_id)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                    action="admin.permission_revoked", result="success", metadata_json=f'{{"assignment_id":"{assignment_id}"}}'))
    if user_role:
        await identity.revoke_role(actor.id, row_id)


async def list_permissions(call, subject_type=None, subject_id=None):
    await _super_admin_read(call)
    async with call.database.session() as session:
        query = select(CapabilityAssignment).where(CapabilityAssignment.revoked_at.is_(None))
        if subject_type:
            column = CapabilityAssignment.user_id if subject_type == "user" else CapabilityAssignment.group_id
            query = query.where(column.is_not(None))
            if subject_id:
                query = query.where(column == subject_id)
        rows = (await session.scalars(query.order_by(CapabilityAssignment.created_at, CapabilityAssignment.id))).all()
        users = {row.id: row.display_name or row.username for row in (await session.scalars(select(User))).all()}
        groups = {row.id: row.name for row in (await session.scalars(select(UserGroup))).all()}
        resources = {row.id: row.name for model in (Device, PlatformProject, DeviceGroup, PlatformProvider)
                     for row in (await session.scalars(select(model))).all()}
        resources.update({row.id: row.display_name for row in (await session.scalars(select(DirectoryDepartment))).all()})
        resources.update({row.id: row.tenant_id for row in (await session.scalars(select(IdentitySource))).all()})
        assignments = [{"id": f"capability:{row.id}", "subject_type": "user" if row.user_id else "group",
            "subject_id": row.user_id or row.group_id,
            "subject_name": (users if row.user_id else groups).get(row.user_id or row.group_id, "未知对象"),
            "permission": row.capability, "scope_type": row.scope_type,
            "scope_id": row.scope_id or None, "scope_name": resources.get(row.scope_id, "全局"),
            "effect": row.effect} for row in rows]
        roles = (await session.scalars(select(AdminAssignment).where(AdminAssignment.revoked_at.is_(None)))).all()
        for row in roles:
            kind, subject = ("user", row.user_id) if row.user_id else ("group", row.group_id)
            if (subject_type and subject_type != kind) or (subject_id and subject_id != subject):
                continue
            assignments.append({"id": f"role:{row.id}", "subject_type": kind, "subject_id": subject,
                "subject_name": (users if kind == "user" else groups).get(subject, "未知对象"),
                "permission": f"admin.{row.role}", "scope_type": row.scope_type, "scope_id": row.scope_id,
                "scope_name": resources.get(row.scope_id, "整个平台"), "effect": "allow",
                "include_subdepartments": bool(row.include_subdepartments)})
        for row in (await session.scalars(select(GroupCapabilityAssignment).where(
                GroupCapabilityAssignment.revoked_at.is_(None)))).all():
            assignments.append({"id": f"group_capability:{row.id}", "subject_type": "group", "subject_id": row.group_id,
                "subject_name": groups.get(row.group_id, "未知对象"), "permission": row.capability,
                "scope_type": "project", "scope_id": row.project_id,
                "scope_name": resources.get(row.project_id, row.project_id), "effect": row.effect})
        for row in (await session.scalars(select(ProjectAccessGrant).where(ProjectAccessGrant.revoked_at.is_(None)))).all():
            assignments.append({"id": f"project:{row.id}", "subject_type": row.subject_type, "subject_id": row.subject_id,
                "subject_name": (users if row.subject_type == "user" else groups).get(row.subject_id, "未知对象"),
                "permission": f"project.{row.access_level}", "scope_type": "project", "scope_id": row.project_id,
                "scope_name": resources.get(row.project_id, row.project_id), "effect": "allow"})
        for kind, model in (("user", UserDevice), ("group", GroupDevice)):
            for row in (await session.scalars(select(model).where(model.revoked_at.is_(None)))).all():
                subject = row.user_id if kind == "user" else row.group_id
                assignments.append({"id": f"device_{kind}:{row.id}", "subject_type": kind, "subject_id": subject,
                    "subject_name": (users if kind == "user" else groups).get(subject, "未知对象"),
                    "permission": "device.access", "scope_type": "device", "scope_id": row.device_id,
                    "scope_name": resources.get(row.device_id, row.device_id), "effect": "allow"})
        for row in (await session.scalars(select(ProviderAssignment).where(
                ProviderAssignment.revoked_at.is_(None), ProviderAssignment.subject_type.in_(("user", "group"))))).all():
            assignments.append({"id": f"provider:{row.id}", "subject_type": row.subject_type, "subject_id": row.subject_id,
                "subject_name": (users if row.subject_type == "user" else groups).get(row.subject_id, "未知对象"),
                "permission": "provider.use", "scope_type": "provider", "scope_id": row.provider_id,
                "scope_name": resources.get(row.provider_id, row.provider_id), "effect": "allow"})
        assignments = [row for row in assignments if (not subject_type or row["subject_type"] == subject_type)
                       and (not subject_id or row["subject_id"] == subject_id)]
    return {"assignments": assignments}
