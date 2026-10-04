from gateway.api.adapters import invoke
from gateway.services.usage_ledger import import_provider_bills as _handle_import_provider_bills, usage_summary as _handle_usage_summary, usage_reconciliation as _handle_usage_reconciliation, usage_events as _handle_usage_events


from datetime import date, datetime


from typing import Literal


from fastapi import APIRouter, Query, Request


from gateway.services.usage_ledger import UsageSource, MeteringStatus, ProviderBillBatch

router = APIRouter(prefix="/api/admin/usage")


@router.post("/provider-bills")
async def import_provider_bills(request: Request, body: ProviderBillBatch):
    return await invoke(_handle_import_provider_bills, request=request, body=body)


@router.get("")
async def usage_summary(request: Request,
                        device_id: str | None = Query(default=None, max_length=64),
                        user_id: str | None = Query(default=None, max_length=64),
                        project_id: str | None = Query(default=None, max_length=64),
                        provider_id: str | None = Query(default=None, max_length=64),
                        model: str | None = Query(default=None, max_length=128),
                        source: UsageSource | None = "reported_by_device",
                        metering_status: MeteringStatus | None = None,
                        from_time: datetime | None = None,
                        to_time: datetime | None = None,
                        group_by: Literal["user", "device", "project", "provider", "model", "day"] | None = None,
                        limit: int = Query(default=100, ge=1, le=1000),
                        offset: int = Query(default=0, ge=0)):
    return await invoke(_handle_usage_summary, request=request, device_id=device_id, user_id=user_id, project_id=project_id, provider_id=provider_id, model=model, source=source, metering_status=metering_status, from_time=from_time, to_time=to_time, group_by=group_by, limit=limit, offset=offset)


@router.get("/reconciliation")
async def usage_reconciliation(request: Request,
                               provider_id: str = Query(min_length=1, max_length=64),
                               from_day: date = Query(), to_day: date = Query()):
    return await invoke(_handle_usage_reconciliation, request=request, provider_id=provider_id, from_day=from_day, to_day=to_day)


@router.get("/events")
async def usage_events(request: Request,
                       device_id: str | None = Query(default=None, max_length=64),
                       user_id: str | None = Query(default=None, max_length=64),
                       project_id: str | None = Query(default=None, max_length=64),
                       provider_id: str | None = Query(default=None, max_length=64),
                       model: str | None = Query(default=None, max_length=128),
                       source: UsageSource | None = None,
                       metering_status: MeteringStatus | None = None,
                       from_time: datetime | None = None,
                       to_time: datetime | None = None,
                       page: int = Query(1, ge=1),
                       page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_usage_events, request=request, device_id=device_id, user_id=user_id, project_id=project_id, provider_id=provider_id, model=model, source=source, metering_status=metering_status, from_time=from_time, to_time=to_time, page=page, page_size=page_size)
