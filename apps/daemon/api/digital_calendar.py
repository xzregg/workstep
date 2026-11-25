"""Included under the host-authorized digital person router."""
import asyncio
from datetime import datetime
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from services.digital_calendar import CalendarDraft, get, public

router = APIRouter(prefix='/calendar')


class Create(CalendarDraft):
    request_id: str | None = Field(default=None,min_length=1,max_length=200)


class Revision(BaseModel):
    revision: str = Field(min_length=1,max_length=100)


class Update(CalendarDraft, Revision):
    pass


class Reminder(Revision):
    early: bool = False


def calendar():
    from api.digital_person import runtime
    return runtime().calendar


async def operation(awaitable):
    try:
        return await awaitable
    except KeyError as exc:
        raise HTTPException(404,'Calendar event not found') from exc
    except ValueError as exc:
        raise HTTPException(409,str(exc)) from exc


@router.get('')
async def list_calendar(since: datetime | None = None,before: datetime | None = None,
                        limit:int=Query(200,ge=1,le=500),offset:int=Query(0,ge=0)):
    return await operation(calendar().list_events(since=since,before=before,limit=limit,offset=offset))


@router.post('')
async def create_calendar(body:Create):
    return await operation(calendar().create(CalendarDraft.model_validate(body.model_dump(exclude={'request_id'})),body.request_id))


@router.get('/{event_id}')
async def get_calendar(event_id:str):
    return public(await operation(asyncio.to_thread(get,event_id)))


@router.put('/{event_id}')
async def update_calendar(event_id:str,body:Update):
    draft=CalendarDraft.model_validate(body.model_dump(exclude={'revision'}))
    return await operation(calendar().update(event_id,draft,body.revision))


@router.delete('/{event_id}')
async def delete_calendar(event_id:str,revision:str=Query(min_length=1,max_length=100)):
    return await operation(calendar().remove(event_id,revision))


@router.post('/{event_id}/restore')
async def restore_calendar(event_id:str,body:Revision):
    return await operation(calendar().restore(event_id,body.revision))


@router.post('/{event_id}/remind')
async def remind_calendar(event_id:str,body:Reminder):
    return await operation(calendar().remind(event_id,body.revision,early=body.early))
