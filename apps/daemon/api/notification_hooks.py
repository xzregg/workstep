"""Editor-only notification configuration, previews, tests and delivery history."""
from fastapi import APIRouter, HTTPException, Query
from api.workflow_hooks import check_edit
from schemas.notification_hooks import SaveNotificationHooks, NotificationPreview
from services.notification_hooks import NotificationHookService
from services.project import project_manager

router=APIRouter(prefix='/api/workflow/{workflow_id}/notification-hooks',tags=['通知钩子'])
service=NotificationHookService(project_manager,None)


@router.get('')
async def configuration(workflow_id:str,project_id:str=Query(...)):
    check_edit(project_id)
    return await service.configuration(project_id,workflow_id)


@router.put('')
async def save(workflow_id:str,body:SaveNotificationHooks,project_id:str=Query(...)):
    check_edit(project_id)
    ids=[h.id for h in body.hooks if h.id]
    if len(ids)!=len(set(ids)):raise HTTPException(422,'钩子 ID 重复')
    await service.save(project_id,workflow_id,body.hooks)
    return await service.configuration(project_id,workflow_id)


@router.post('/preview')
async def preview(workflow_id:str,body:NotificationPreview,project_id:str=Query(...)):
    check_edit(project_id)
    return await service.preview(project_id,workflow_id,body.hook,body.event,body.title,body.step)


@router.post('/{hook_id}/test',status_code=202)
async def test(workflow_id:str,hook_id:str,project_id:str=Query(...)):
    check_edit(project_id)
    return {'delivery_id':await service.test(project_id,workflow_id,hook_id)}


@router.get('/{hook_id}/deliveries')
async def deliveries(workflow_id:str,hook_id:str,project_id:str=Query(...),offset:int=Query(0,ge=0)):
    check_edit(project_id)
    return {'deliveries':await service.records(project_id,workflow_id,hook_id,offset)}


@router.post('/{hook_id}/deliveries/{delivery_id}/retry',status_code=202)
async def retry(workflow_id:str,hook_id:str,delivery_id:str,project_id:str=Query(...)):
    check_edit(project_id)
    await service.retry(project_id,workflow_id,hook_id,delivery_id)
    return {'delivery_id':delivery_id}
