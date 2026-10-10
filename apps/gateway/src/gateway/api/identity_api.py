from gateway.api.adapters import invoke
from gateway.services.identity_api import setup as _handle_setup, platform_status as _handle_platform_status, register as _handle_register, registration_policy as _handle_registration_policy, login as _handle_login, session as _handle_session, admin_access as _handle_admin_access, logout as _handle_logout, change_password as _handle_change_password, step_up as _handle_step_up, admin_create_user as _handle_admin_create_user, admin_list_users as _handle_admin_list_users, admin_approve_user as _handle_admin_approve_user, admin_disable_user as _handle_admin_disable_user, admin_grant_role as _handle_admin_grant_role, admin_list_roles as _handle_admin_list_roles, admin_revoke_role as _handle_admin_revoke_role, admin_list_departments as _handle_admin_list_departments, admin_set_registration_policy as _handle_admin_set_registration_policy, admin_platform_settings as _handle_admin_platform_settings, admin_reset_password as _handle_admin_reset_password


from typing import Literal

from fastapi import APIRouter, Query, Request, Response


from gateway.services.identity_api import AccountInput, SetupInput, LoginInput, ChangePasswordInput, StepUpInput, ResetPasswordInput, AdminCreateInput, GrantRoleInput, RegistrationPolicyInput

from gateway.services.admin_user_operations import BulkUserInput, bulk_users as _handle_bulk_users
from gateway.services.login_policy import LoginPolicyInput, set_login_policy as _handle_login_policy

from gateway.services.platform_address import PlatformAddressInput, set_platform_address as _handle_platform_address

router = APIRouter(prefix="/api")


@router.put('/admin/login-policy')
async def set_login_policy(request: Request, body: LoginPolicyInput):
    return await invoke(_handle_login_policy, request=request, body=body)


@router.post('/admin/users/bulk')
async def bulk_users(request: Request, body: BulkUserInput):
    return await invoke(_handle_bulk_users, request=request, body=body)


@router.post("/platform/setup", status_code=201)
async def setup(request: Request, response: Response, body: SetupInput):
    return await invoke(_handle_setup, request=request, response=response, body=body)


@router.get("/platform/status")
async def platform_status(request: Request):
    return await invoke(_handle_platform_status, request=request)


@router.post("/auth/register")
async def register(request: Request, response: Response, body: AccountInput):
    return await invoke(_handle_register, request=request, response=response, body=body)


@router.get("/auth/registration-policy")
async def registration_policy(request: Request):
    return await invoke(_handle_registration_policy, request=request)


@router.post("/auth/login")
async def login(request: Request, response: Response, body: LoginInput):
    return await invoke(_handle_login, request=request, response=response, body=body)


@router.get("/auth/session")
async def session(request: Request, response: Response):
    return await invoke(_handle_session, request=request, response=response)


@router.get("/auth/admin-access")
async def admin_access(request: Request):
    return await invoke(_handle_admin_access, request=request)


@router.post("/auth/logout", status_code=204)
async def logout(request: Request, response: Response):
    return await invoke(_handle_logout, request=request, response=response)


@router.post("/auth/password", status_code=204)
async def change_password(request: Request, body: ChangePasswordInput):
    return await invoke(_handle_change_password, request=request, body=body)


@router.post("/auth/step-up")
async def step_up(request: Request, body: StepUpInput):
    return await invoke(_handle_step_up, request=request, body=body)


@router.post("/admin/users", status_code=201)
async def admin_create_user(request: Request, body: AdminCreateInput):
    return await invoke(_handle_admin_create_user, request=request, body=body)


@router.get("/admin/users")
async def admin_list_users(request: Request, q: str = Query("", max_length=128),
                           group_id: str | None = Query(None, max_length=64),
                           status: Literal["active", "pending", "disabled", "deleted"] | None = None,
                           sort: Literal["username", "display_name", "created_at"] = "created_at",
                           direction: Literal["asc", "desc"] = "desc",
                           page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_admin_list_users, request=request, q=q, group_id=group_id, status=status, sort=sort, direction=direction, page=page, page_size=page_size)


@router.post("/admin/users/{user_id}/approve", status_code=204)
async def admin_approve_user(request: Request, user_id: str):
    return await invoke(_handle_admin_approve_user, request=request, user_id=user_id)


@router.post("/admin/users/{user_id}/disable", status_code=204)
async def admin_disable_user(request: Request, user_id: str):
    return await invoke(_handle_admin_disable_user, request=request, user_id=user_id)


@router.post("/admin/users/{user_id}/roles", status_code=201)
async def admin_grant_role(request: Request, user_id: str, body: GrantRoleInput):
    return await invoke(_handle_admin_grant_role, request=request, user_id=user_id, body=body)


@router.get("/admin/roles")
async def admin_list_roles(request: Request, q: str = Query("", max_length=128),
                           role: Literal["identity_admin", "org_admin", "department_admin", "device_admin", "skill_admin", "audit_admin", "super_admin"] | None = None,
                           sort: Literal["created_at", "username", "role"] = "created_at",
                           direction: Literal["asc", "desc"] = "desc",
                           page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_admin_list_roles, request=request, q=q, role=role, sort=sort, direction=direction, page=page, page_size=page_size)


@router.delete("/admin/roles/{assignment_id}", status_code=204)
async def admin_revoke_role(request: Request, assignment_id: str):
    return await invoke(_handle_admin_revoke_role, request=request, assignment_id=assignment_id)


@router.get("/admin/departments")
async def admin_list_departments(request: Request, q: str = Query("", max_length=128),
                                 sort: Literal["display_name", "external_id"] = "display_name",
                                 direction: Literal["asc", "desc"] = "asc",
                                 page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_admin_list_departments, request=request, q=q, sort=sort, direction=direction, page=page, page_size=page_size)


@router.put("/admin/registration-policy")
async def admin_set_registration_policy(request: Request, body: RegistrationPolicyInput):
    return await invoke(_handle_admin_set_registration_policy, request=request, body=body)


@router.get("/admin/platform-settings")
async def admin_platform_settings(request: Request):
    return await invoke(_handle_admin_platform_settings, request=request)


@router.post("/admin/users/{user_id}/reset-password", status_code=204)
async def admin_reset_password(request: Request, user_id: str, body: ResetPasswordInput):
    return await invoke(_handle_admin_reset_password, request=request, user_id=user_id, body=body)


@router.put('/admin/platform-address')
async def set_platform_address(request: Request, body: PlatformAddressInput):
    return await invoke(_handle_platform_address, request=request, body=body)


from gateway.services.device_approval_policy import DeviceApprovalPolicyInput, set_device_approval_policy

@router.put('/admin/device-approval-policy')
async def device_approval_policy(request: Request, body: DeviceApprovalPolicyInput):
    return await invoke(set_device_approval_policy, request=request, body=body)


from gateway.services.identity_api import AdminEditUserInput, admin_edit_user as _handle_admin_edit_user


@router.patch('/admin/users/{user_id}')
async def admin_edit_user(request: Request, user_id: str, body: AdminEditUserInput):
    return await invoke(_handle_admin_edit_user, request=request, user_id=user_id, body=body)
