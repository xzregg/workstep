from gateway.api.adapters import invoke
from gateway.services.platform_shares import create_platform_share as _handle_create_platform_share, list_own_platform_shares as _handle_list_own_platform_shares, revoke_platform_share as _handle_revoke_platform_share, public_share_meta as _handle_public_share_meta, unlock_public_share as _handle_unlock_public_share, public_share_session as _handle_public_share_session, public_share_task as _handle_public_share_task, public_share_execution_report as _handle_public_share_execution_report, public_share_host_status as _handle_public_share_host_status, public_share_history as _handle_public_share_history, public_share_history_page as _handle_public_share_history_page, public_share_events as _handle_public_share_events, public_share_artifacts as _handle_public_share_artifacts, public_share_reviews as _handle_public_share_reviews, public_share_interventions as _handle_public_share_interventions, public_share_artifact_content as _handle_public_share_artifact_content, public_share_artifact_preview as _handle_public_share_artifact_preview, public_share_upload as _handle_public_share_upload, public_share_upload_content as _handle_public_share_upload_content, public_share_git_read as _handle_public_share_git_read, public_share_git_workspace as _handle_public_share_git_workspace, public_share_git_status as _handle_public_share_git_status, public_share_git_branches as _handle_public_share_git_branches, public_share_git_commit as _handle_public_share_git_commit, public_share_git_switch as _handle_public_share_git_switch, public_share_git_fetch as _handle_public_share_git_fetch, public_share_git_create_branch as _handle_public_share_git_create_branch, public_share_git_delete_branch as _handle_public_share_git_delete_branch, public_share_git_sync as _handle_public_share_git_sync, public_share_step_message as _handle_public_share_step_message, public_share_step_resume as _handle_public_share_step_resume, public_share_step_cancel as _handle_public_share_step_cancel, public_share_review_decision as _handle_public_share_review_decision, public_share_intervention_response as _handle_public_share_intervention_response


from fastapi import APIRouter, Query, Request


from gateway.services.platform_shares import CreateShareInput, UnlockShareInput

router = APIRouter(prefix="/api")


@router.post("/platform-shares", status_code=201)
async def create_platform_share(request: Request, body: CreateShareInput):
    return await invoke(_handle_create_platform_share, request=request, body=body)


@router.get("/platform-shares")
async def list_own_platform_shares(request: Request,
                                   project_id: str = Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"),
                                   task_id: str = Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")):
    return await invoke(_handle_list_own_platform_shares, request=request, project_id=project_id, task_id=task_id)


@router.post("/platform-shares/{share_id}/revoke", status_code=204)
async def revoke_platform_share(request: Request, share_id: str):
    return await invoke(_handle_revoke_platform_share, request=request, share_id=share_id)


@router.get("/public/shares/{token}/meta")
async def public_share_meta(request: Request, token: str):
    return await invoke(_handle_public_share_meta, request=request, token=token)


@router.post("/public/shares/{token}/unlock")
async def unlock_public_share(request: Request, token: str, body: UnlockShareInput):
    return await invoke(_handle_unlock_public_share, request=request, token=token, body=body)


@router.get("/public/shares/{token}/session")
async def public_share_session(request: Request, token: str):
    return await invoke(_handle_public_share_session, request=request, token=token)


@router.get("/public/shares/{token}/task")
async def public_share_task(request: Request, token: str):
    return await invoke(_handle_public_share_task, request=request, token=token)


@router.get('/public/shares/{token}/execution-report')
async def public_share_execution_report(request: Request, token: str):
    return await invoke(_handle_public_share_execution_report, request=request, token=token)


@router.get("/public/shares/{token}/host-status")
async def public_share_host_status(request: Request, token: str):
    return await invoke(_handle_public_share_host_status, request=request, token=token)


@router.get("/public/shares/{token}/history")
async def public_share_history(request: Request, token: str):
    return await invoke(_handle_public_share_history, request=request, token=token)


@router.get("/public/shares/{token}/history/{offset}")
async def public_share_history_page(request: Request, token: str, offset: int):
    return await invoke(_handle_public_share_history_page, request=request, token=token, offset=offset)


@router.get("/public/shares/{token}/events/{message_id}/{cursor}")
async def public_share_events(request: Request, token: str, message_id: str, cursor: int):
    return await invoke(_handle_public_share_events, request=request, token=token, message_id=message_id, cursor=cursor)


@router.get("/public/shares/{token}/artifacts")
async def public_share_artifacts(request: Request, token: str):
    return await invoke(_handle_public_share_artifacts, request=request, token=token)


@router.get("/public/shares/{token}/reviews")
async def public_share_reviews(request: Request, token: str):
    return await invoke(_handle_public_share_reviews, request=request, token=token)


@router.get("/public/shares/{token}/interventions")
async def public_share_interventions(request: Request, token: str):
    return await invoke(_handle_public_share_interventions, request=request, token=token)


@router.get("/public/shares/{token}/artifacts/{artifact_id}/content")
async def public_share_artifact_content(request: Request, token: str, artifact_id: str):
    return await invoke(_handle_public_share_artifact_content, request=request, token=token, artifact_id=artifact_id)


@router.get("/public/shares/{token}/artifacts/{artifact_id}/preview")
async def public_share_artifact_preview(request: Request, token: str, artifact_id: str):
    return await invoke(_handle_public_share_artifact_preview, request=request, token=token, artifact_id=artifact_id)


@router.post("/public/shares/{token}/uploads")
async def public_share_upload(request: Request, token: str):
    return await invoke(_handle_public_share_upload, request=request, token=token)


@router.get("/public/shares/{token}/uploads/{filename}")
async def public_share_upload_content(request: Request, token: str, filename: str):
    return await invoke(_handle_public_share_upload_content, request=request, token=token, filename=filename)


@router.get("/public/shares/{token}/git/read/{action}/{encoded}")
async def public_share_git_read(request: Request, token: str, action: str, encoded: str):
    return await invoke(_handle_public_share_git_read, request=request, token=token, action=action, encoded=encoded)


@router.get("/public/shares/{token}/git/workspace")
async def public_share_git_workspace(request: Request, token: str):
    return await invoke(_handle_public_share_git_workspace, request=request, token=token)


@router.get("/public/shares/{token}/git/worktrees/{tree_id}/status")
async def public_share_git_status(request: Request, token: str, tree_id: str):
    return await invoke(_handle_public_share_git_status, request=request, token=token, tree_id=tree_id)


@router.get("/public/shares/{token}/git/worktrees/{tree_id}/branches")
async def public_share_git_branches(request: Request, token: str, tree_id: str):
    return await invoke(_handle_public_share_git_branches, request=request, token=token, tree_id=tree_id)


@router.post("/public/shares/{token}/git/worktrees/{tree_id}/commit")
async def public_share_git_commit(request: Request, token: str, tree_id: str):
    return await invoke(_handle_public_share_git_commit, request=request, token=token, tree_id=tree_id)


@router.post("/public/shares/{token}/git/worktrees/{tree_id}/switch")
async def public_share_git_switch(request: Request, token: str, tree_id: str):
    return await invoke(_handle_public_share_git_switch, request=request, token=token, tree_id=tree_id)


@router.post("/public/shares/{token}/git/worktrees/{tree_id}/fetch")
async def public_share_git_fetch(request: Request, token: str, tree_id: str):
    return await invoke(_handle_public_share_git_fetch, request=request, token=token, tree_id=tree_id)


@router.post("/public/shares/{token}/git/worktrees/{tree_id}/branches")
async def public_share_git_create_branch(request: Request, token: str, tree_id: str):
    return await invoke(_handle_public_share_git_create_branch, request=request, token=token, tree_id=tree_id)


@router.post("/public/shares/{token}/git/worktrees/{tree_id}/branches/delete")
async def public_share_git_delete_branch(request: Request, token: str, tree_id: str):
    return await invoke(_handle_public_share_git_delete_branch, request=request, token=token, tree_id=tree_id)


@router.post("/public/shares/{token}/git/worktrees/{tree_id}/{action}")
async def public_share_git_sync(request: Request, token: str, tree_id: str, action: str):
    return await invoke(_handle_public_share_git_sync, request=request, token=token, tree_id=tree_id, action=action)


@router.post("/public/shares/{token}/steps/{step_key}/message")
async def public_share_step_message(request: Request, token: str, step_key: str):
    return await invoke(_handle_public_share_step_message, request=request, token=token, step_key=step_key)


@router.post("/public/shares/{token}/steps/{step_key}/resume")
async def public_share_step_resume(request: Request, token: str, step_key: str):
    return await invoke(_handle_public_share_step_resume, request=request, token=token, step_key=step_key)


@router.post("/public/shares/{token}/steps/{step_key}/cancel")
async def public_share_step_cancel(request: Request, token: str, step_key: str):
    return await invoke(_handle_public_share_step_cancel, request=request, token=token, step_key=step_key)


@router.post("/public/shares/{token}/steps/{step_key}/review/{decision}")
async def public_share_review_decision(request: Request, token: str,
                                       step_key: str, decision: str):
    return await invoke(_handle_public_share_review_decision, request=request, token=token, step_key=step_key, decision=decision)


@router.post("/public/shares/{token}/interventions/{interaction_id}/respond")
async def public_share_intervention_response(request: Request, token: str,
                                             interaction_id: str):
    return await invoke(_handle_public_share_intervention_response, request=request, token=token, interaction_id=interaction_id)
