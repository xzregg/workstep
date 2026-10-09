"""Remove a Gateway registration and its grants; local files remain on the host."""
import json
from uuid import uuid4
from sqlalchemy import delete, or_, select
from gateway.models import (AuditEvent, CapabilityAssignment, CompletionNotification,
    DesktopAuthCode, Device, DeviceCommand, DeviceConnection, DeviceGroupMembership,
    DeviceProjectSkillState, DeviceProviderApplication, GroupCapabilityAssignment,
    GroupDevice, GroupProject, PlatformProject, PlatformShare, PlatformShareSession,
    ProjectAccessGrant, ProjectSkillAssignment, ProviderAssignment, UsedDeviceAccessTicket, UserDevice)
from gateway.services.errors import GatewayError


async def delete_device_registration(database, device_id: str, actor_id: str):
    async with database.session() as session:
        async with session.begin():
            device = await session.get(Device, device_id)
            if device is None:
                raise GatewayError('not_found', 'Device not found')
            projects = select(PlatformProject.id).where(PlatformProject.device_id == device_id)
            shares = select(PlatformShare.id).where(or_(
                PlatformShare.device_id == device_id, PlatformShare.project_id.in_(projects)))
            await session.execute(delete(PlatformShareSession).where(PlatformShareSession.share_id.in_(shares)))
            await session.execute(delete(PlatformShare).where(PlatformShare.id.in_(shares)))
            await session.execute(delete(DeviceProjectSkillState).where(or_(
                DeviceProjectSkillState.device_id == device_id, DeviceProjectSkillState.platform_project_id.in_(projects))))
            for model, column in ((GroupCapabilityAssignment, GroupCapabilityAssignment.project_id),
                                  (GroupProject, GroupProject.platform_project_id),
                                  (ProjectAccessGrant, ProjectAccessGrant.project_id),
                                  (ProjectSkillAssignment, ProjectSkillAssignment.platform_project_id)):
                await session.execute(delete(model).where(column.in_(projects)))
            await session.execute(delete(CapabilityAssignment).where(or_(
                (CapabilityAssignment.scope_type == 'device') & (CapabilityAssignment.scope_id == device_id),
                (CapabilityAssignment.scope_type == 'project') & CapabilityAssignment.scope_id.in_(projects))))
            await session.execute(delete(ProviderAssignment).where(
                ProviderAssignment.subject_type == 'device', ProviderAssignment.subject_id == device_id))
            await session.execute(delete(PlatformProject).where(PlatformProject.device_id == device_id))
            for model in (CompletionNotification, DeviceCommand, DeviceConnection, DeviceGroupMembership,
                          DeviceProviderApplication, GroupDevice, UsedDeviceAccessTicket, UserDevice):
                await session.execute(delete(model).where(model.device_id == device_id))
            if device.app_instance_id:
                await session.execute(delete(DesktopAuthCode).where(DesktopAuthCode.app_instance_id == device.app_instance_id))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor_id, device_id=device_id,
                action='admin.device_deleted', result='success',
                metadata_json=json.dumps({'device_name': device.name}, ensure_ascii=False)))
            await session.delete(device)
