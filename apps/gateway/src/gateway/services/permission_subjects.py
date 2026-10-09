"""Live group membership shared by capability, role and provider authorization."""
from sqlalchemy import select
from gateway.models import AdminAssignment, GroupMembership, UserGroup, User


def active_group_ids(user_id: str):
    return select(GroupMembership.group_id).join(UserGroup).join(
        User, User.id == GroupMembership.user_id,
    ).where(GroupMembership.user_id == user_id, GroupMembership.revoked_at.is_(None),
            UserGroup.status == "active", User.status == "active")


def active_super_admin_user_ids():
    direct = select(AdminAssignment.user_id).where(
        AdminAssignment.role == "super_admin", AdminAssignment.revoked_at.is_(None))
    inherited = select(GroupMembership.user_id).join(UserGroup).join(
        AdminAssignment, AdminAssignment.group_id == GroupMembership.group_id,
    ).where(GroupMembership.revoked_at.is_(None), UserGroup.status == "active",
            AdminAssignment.role == "super_admin", AdminAssignment.revoked_at.is_(None))
    return select(User.id).where(User.status == "active", User.id.in_(direct.union(inherited)))
