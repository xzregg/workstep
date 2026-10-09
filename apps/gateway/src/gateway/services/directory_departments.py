"""Shared eligibility for department selectors and device assignment."""
from sqlalchemy import and_, exists, select, literal
from gateway.models import DirectoryDepartment, UserGroup, PlatformSetting


def assignable_department():
    unavailable_group = exists(select(UserGroup.id).where(
        UserGroup.external_department_id == DirectoryDepartment.id,
        UserGroup.status != 'active',
    ))
    purged_group = exists(select(PlatformSetting.key).where(
        PlatformSetting.key == literal('directory-group-purged:') + DirectoryDepartment.id,
    ))
    return and_(DirectoryDepartment.active == 1, ~unavailable_group, ~purged_group)
