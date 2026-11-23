"""Included below the digital-person host authorization dependency."""
import asyncio
import sqlite3
from fastapi import APIRouter, HTTPException
from pydantic import Field
from services import face_recognition as service, face_welcome

router = APIRouter(prefix='/faces')


async def call(operation, *args):
    try:
        return await asyncio.to_thread(operation, *args)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(503, 'The face library is temporarily unavailable, please try again') from exc


@router.get('/settings')
async def settings(): return await call(service.get_settings)

@router.put('/settings')
async def save_settings(value: service.Settings): return await call(service.save_settings,value)

@router.get('/revision')
async def revision(): return await call(service.revision)

@router.get('/catalog')
async def catalog(): return await call(service.catalog)

@router.get('/welcome', response_model=face_welcome.Settings)
async def welcome_settings():
    return await call(face_welcome.settings)


@router.put('/welcome', response_model=face_welcome.Settings)
async def save_welcome(value: face_welcome.Settings):
    return await call(face_welcome.save, value)


@router.post('/welcome/offer', response_model=face_welcome.Welcome | None)
async def offer_welcome(value: face_welcome.Candidate):
    from api.digital_person import runtime
    last_user, busy = await runtime().face_welcome_activity()
    if busy:
        return None
    return await call(face_welcome.offer, value, last_user)


@router.get('/people')
async def people(): return {'items': await call(service.people)}

@router.post('/people')
async def create(value: service.Enrollment): return await call(service.create,value)

@router.put('/people/{pid}')
async def update(pid: str, value: service.PersonEdit): return await call(service.update,pid,value)

@router.delete('/people/{pid}')
async def delete(pid: str): return await call(service.delete,pid)

@router.get('/people/{pid}/samples')
async def samples(pid: str): return {'items': await call(service.samples,pid)}

@router.post('/people/{pid}/samples')
async def add_samples(pid: str, value: service.Samples): return await call(service.add_samples,pid,value)

@router.delete('/people/{pid}/samples/{sid}')
async def delete_sample(pid: str, sid: str): return await call(service.delete_sample,pid,sid)


class FrameContext(service.StrictModel):
    person_ids: list[str] = Field(max_length=8)
    unknown_count: int = Field(default=0, ge=0, le=8)


@router.post('/context')
async def context(value: FrameContext):
    return await call(service.context,value.person_ids,value.unknown_count)
