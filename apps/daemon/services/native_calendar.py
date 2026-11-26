"""Durable host calendar operations. Sync methods run only in a worker.

System events remain visible until a verified device receipt commits their state.
No native command or credential is published on the global event bus.
"""
from datetime import date,datetime,timedelta,time,timezone
import hashlib
import hmac
import json
import secrets
import uuid
from zoneinfo import ZoneInfo
from typing import Literal
from pydantic import BaseModel,ConfigDict,Field
from services import digital_calendar as calendar


class BatchSchedule(BaseModel):
    model_config=ConfigDict(extra='forbid')
    start_date:date
    end_date:date
    time:str=Field(pattern=r'^\d{2}:\d{2}$')
    timezone_name:str='UTC'


class OperationDraft(BaseModel):
    model_config=ConfigDict(extra='forbid')
    action:Literal['create','query','update','delete']
    target_id:str=Field(min_length=1,max_length=100)
    request_id:str=Field(min_length=1,max_length=200)
    content:str|None=Field(default=None,min_length=1,max_length=20000)
    starts_at:datetime|None=None
    timezone_name:str='UTC'
    reminder_minutes:int=Field(default=0,ge=0,le=10080)
    duration_minutes:int|None=Field(default=None,ge=1,le=10080)
    schedule:BatchSchedule|None=None
    draft:calendar.CalendarDraft|None=None
    event_id:str|None=Field(default=None,max_length=100)
    revision:str|None=Field(default=None,max_length=100)
    plan_id:str|None=Field(default=None,max_length=100)
    dates:list[date]|None=Field(default=None,max_length=100)
    exclude_dates:list[date]|None=Field(default=None,max_length=100)
    since:datetime|None=None
    before:datetime|None=None
    origin_project_id:str|None=Field(default=None,max_length=100)
    origin_session_id:str|None=Field(default=None,max_length=100)


def uid():return str(uuid.uuid4())
def stamp():return datetime.now(timezone.utc).isoformat()
def digest(value):return hashlib.sha256(value.encode()).hexdigest()


class _Operation(dict):
    """Transient original values let checkpoints update only changed child rows."""
    pass


class CalendarApplication:
    def __init__(self,owner):self.owner=owner

    def connect(self):return calendar.connection()

    def schema(self,db):
        db.executescript('''CREATE TABLE IF NOT EXISTS calendar_devices (
            id TEXT PRIMARY KEY,owner TEXT NOT NULL,key_hash TEXT NOT NULL,value_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS calendar_operations (
            id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,status TEXT NOT NULL,
            request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,value_json TEXT NOT NULL,
            UNIQUE(owner,request_id));
            CREATE INDEX IF NOT EXISTS calendar_operation_device ON calendar_operations(owner,device_id,status);
            CREATE TABLE IF NOT EXISTS calendar_operation_items (
            operation_id TEXT NOT NULL,item_id TEXT NOT NULL,position INTEGER NOT NULL,value_json TEXT NOT NULL,
            PRIMARY KEY(operation_id,item_id));
            CREATE TABLE IF NOT EXISTS calendar_links (
            event_id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,calendar_id TEXT NOT NULL,
            target_id TEXT NOT NULL,system_id TEXT NOT NULL,plan_id TEXT NOT NULL,local_date TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS calendar_link_plan ON calendar_links(owner,plan_id,local_date);''')

    def device(self,db,device_id,key=None):
        row=db.execute('SELECT * FROM calendar_devices WHERE id=? AND owner=?',(device_id,self.owner)).fetchone()
        if row is None:raise KeyError('Calendar device not found')
        if key is not None and not hmac.compare_digest(row['key_hash'],digest(key)):
            raise PermissionError('Invalid calendar device credential')
        return json.loads(row['value_json'])

    def register(self,body):
        device_id=str(body.get('device_id',''));key=str(body.get('key',''))
        if not 1<=len(device_id)<=100 or not 32<=len(key)<=200:raise ValueError('Invalid calendar device registration')
        if body.get('platform') not in ('android','macos'):raise ValueError('Unsupported calendar platform')
        calendars=body.get('calendars',[])
        if not isinstance(calendars,list) or len(calendars)>100:raise ValueError('Too many calendars')
        targets=[]
        for row in calendars or [{'id':'','name':'System calendar'}]:
            system_id=str(row.get('id',''))[:500]
            targets.append({'id':str(uuid.uuid5(uuid.NAMESPACE_URL,device_id+':'+system_id)),
                            'calendar_id':system_id,'name':str(row.get('name',''))[:200],'available':bool(system_id),
                            'device_id':device_id,'device_name':str(body.get('name',''))[:100]})
        value={'id':device_id,'owner':self.owner,'name':str(body.get('name',''))[:100],'platform':body['platform'],
               'permission':body.get('permission') if body.get('permission') in ('granted','denied','not_determined','restricted','unsupported') else 'not_determined',
               'targets':targets,'checked_at':stamp()}
        with self.connect() as db:
            self.schema(db)
            existing=db.execute('SELECT owner,key_hash,value_json FROM calendar_devices WHERE id=?',(device_id,)).fetchone()
            if existing and (existing['owner']!=self.owner or not hmac.compare_digest(existing['key_hash'],digest(key))):
                raise PermissionError('Calendar device is already registered to another identity')
            if existing and value['permission']!='granted':value['targets']=json.loads(existing['value_json'])['targets']
            db.execute('INSERT OR REPLACE INTO calendar_devices VALUES(?,?,?,?)',(device_id,self.owner,digest(key),json.dumps(value)))
        return value

    def targets(self):
        with self.connect() as db:
            self.schema(db)
            rows=db.execute('SELECT value_json FROM calendar_devices WHERE owner=?',(self.owner,)).fetchall()
            return [{'id':'internal','name':'WorkStep','device_id':'','permission':'granted'},
                    *[{**target,'permission':device['permission'],'platform':device['platform'],'checked_at':device['checked_at']}
                      for row in rows for device in [json.loads(row[0])] for target in device['targets']]]

    def _operation(self,db,operation_id):
        row=db.execute('SELECT value_json FROM calendar_operations WHERE id=? AND owner=?',(operation_id,self.owner)).fetchone()
        if row is None:raise KeyError('Calendar operation not found')
        op=_Operation(json.loads(row[0]))
        rows=db.execute('SELECT item_id,value_json FROM calendar_operation_items WHERE operation_id=? ORDER BY position',(operation_id,)).fetchall()
        op.original_items={row['item_id']:row['value_json'] for row in rows}
        if 'items' not in op:op['items']=[json.loads(row['value_json']) for row in rows]
        return op

    @staticmethod
    def _metadata(op):return json.dumps({key:value for key,value in op.items() if key!='items'},ensure_ascii=False)

    def _save_items(self,db,op):
        original=getattr(op,'original_items',{})
        for position,item in enumerate(op['items']):
            value=json.dumps(item,ensure_ascii=False)
            if original.get(item['id'])!=value:
                db.execute('INSERT INTO calendar_operation_items VALUES(?,?,?,?) ON CONFLICT(operation_id,item_id) DO UPDATE SET value_json=excluded.value_json',
                           (op['id'],item['id'],position,value))
                original[item['id']]=value

    def _save(self,db,op):
        statuses={item['status'] for item in op['items']}
        if op.get('cancel_requested'):
            for item in op['items']:
                if item['status']=='queued':item['status']='cancelled'
            statuses={item['status'] for item in op['items']}
        if not statuses or statuses=={'succeeded'}:op['status']='succeeded'
        elif statuses<= {'succeeded','failed','unknown','cancelled'}:
            op['status']='partial' if 'succeeded' in statuses else ('unknown' if 'unknown' in statuses else 'cancelled' if statuses=={'cancelled'} else 'failed')
        elif op['status'] not in ('needs_permission','needs_calendar','executing'):op['status']='queued'
        op['updated_at']=stamp()
        self._save_items(db,op)
        db.execute('UPDATE calendar_operations SET status=?,value_json=? WHERE id=?',(op['status'],self._metadata(op),op['id']))
        return op

    def operation(self,operation_id,private=False):
        with self.connect() as db:
            self.schema(db);op=self._operation(db,operation_id)
            return op if private else self.public(op)

    @staticmethod
    def public(op):
        return {**{k:v for k,v in op.items() if k not in ('token','payload_hash')},
                'items':[{k:v for k,v in item.items() if k not in ('system_id','calendar_id')} for item in op['items']]}

    def _drafts(self,body):
        if 'schedule' not in body:return [calendar.CalendarDraft.model_validate({k:body[k] for k in ('content','starts_at','timezone_name','reminder_minutes') if k in body})]
        schedule=body['schedule'];start=date.fromisoformat(schedule['start_date']);end=date.fromisoformat(schedule['end_date'])
        if not 0<=(end-start).days<100:raise ValueError('Calendar batch must contain 1 to 100 dates')
        clock=time.fromisoformat(schedule['time'])
        if clock.tzinfo:raise ValueError('Use local HH:mm and timezone_name')
        zone=ZoneInfo(schedule.get('timezone_name','UTC'))
        excluded=set(body.get('exclude_dates',[]));rows=[]
        for i in range((end-start).days+1):
            day=start+timedelta(days=i)
            if day.isoformat() in excluded:continue
            local=datetime.combine(day,clock.replace(second=0,microsecond=0),zone)
            if local.utcoffset()!=local.replace(fold=1).utcoffset() or local.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)!=local.replace(tzinfo=None):
                raise ValueError('Calendar time is ambiguous or missing across daylight saving; choose an explicit time')
            rows.append(calendar.CalendarDraft(content=body['content'],starts_at=local,timezone_name=str(zone),reminder_minutes=body.get('reminder_minutes',0)))
        if not rows:raise ValueError('Calendar batch cannot be empty')
        return rows

    def submit(self,body):
        if len(json.dumps(body))>250000:raise ValueError('Calendar operation is too large')
        key=str(body.get('request_id',''))
        if not 1<=len(key)<=200:raise ValueError('A stable request_id is required')
        action=body.get('action');target_id=body.get('target_id','internal')
        if action not in ('create','update','delete','query'):raise ValueError('Invalid calendar action')
        if action=='update' and not body.get('event_id'):raise ValueError('Update one explicitly identified event at a time')
        if action in ('update','delete') and body.get('event_id') and not body.get('revision'):raise ValueError('The current event revision is required')
        payload_hash=digest(json.dumps(body,sort_keys=True))
        with self.connect() as db:
            self.schema(db)
            old=db.execute('SELECT value_json FROM calendar_operations WHERE owner=? AND request_id=?',(self.owner,key)).fetchone()
            if old:
                op=self._operation(db,json.loads(old[0])['id'])
                if op['payload_hash']!=payload_hash:raise ValueError('Calendar request_id already used with another payload')
                return self.public(op)
        target=next((row for row in self.targets() if row['id']==target_id),None)
        if target is None:raise KeyError('Calendar target not found')
        duration=int(body.get('duration_minutes',30))
        if not 1<=duration<=10080:raise ValueError('Invalid calendar duration')
        with self.connect() as db:
            self.schema(db)
            old=db.execute('SELECT value_json FROM calendar_operations WHERE owner=? AND request_id=?',(self.owner,key)).fetchone()
            if old:
                op=self._operation(db,json.loads(old[0])['id'])
                if op['payload_hash']!=payload_hash:raise ValueError('Calendar request_id already used with another payload')
                return self.public(op)
            op={'id':uid(),'plan_id':body.get('plan_id') or uid(),'target_id':target_id,'device_id':target['device_id'],
                'calendar_id':target.get('calendar_id',''),'action':action,'request_id':key,'payload_hash':payload_hash,
                'status':'queued','created_at':stamp(),'updated_at':stamp(),'cancel_requested':False,'items':[]}
            op.update(origin_project_id=body.get('origin_project_id'),origin_session_id=body.get('origin_session_id'))
            if action=='create':
                for draft in self._drafts(body):
                    op['items'].append({'id':uid(),'event_id':uid(),'status':'queued','draft':draft.model_dump(mode='json'),'duration_minutes':duration})
            else:
                event_ids=body.get('event_ids',[])
                if body.get('event_id'):event_ids=[body['event_id']]
                if body.get('plan_id'):
                    links=db.execute('SELECT * FROM calendar_links WHERE owner=? AND plan_id=? AND target_id=?',(self.owner,body['plan_id'],target_id)).fetchall()
                    event_ids=[row['event_id'] for row in links if not body.get('dates') or row['local_date'] in body['dates']]
                if action=='query' and not event_ids:
                    since=calendar.aware(datetime.fromisoformat(body['since']));before=calendar.aware(datetime.fromisoformat(body['before']))
                    if before<=since or before-since>timedelta(days=370):raise ValueError('Calendar query range must be positive and at most 370 days')
                    if target_id=='internal':
                        event_ids=[row[0] for row in db.execute("SELECT id FROM digital_calendar WHERE deleted=0 AND starts_at>=? AND starts_at<? AND json_extract(value_json,'$.reminder_owner') IS NOT 'system' LIMIT 101",(since.timestamp(),before.timestamp()))]
                    else:
                        links=db.execute('SELECT event_id FROM calendar_links WHERE owner=? AND target_id=?',(self.owner,target_id)).fetchall()
                        event_ids=[row[0] for row in links if not calendar._read(db,row[0],deleted=True).get('deleted_at') and since<=datetime.fromisoformat(calendar._read(db,row[0],deleted=True)['starts_at'])<before]
                if len(event_ids)>100 or (not event_ids and action!='query'):raise ValueError('Select 1 to 100 linked calendar events')
                for event_id in dict.fromkeys(event_ids):
                    event=calendar._read(db,event_id)
                    if event.get('target_id','internal')!=target_id:raise ValueError('Use the event original calendar destination')
                    link=db.execute('SELECT * FROM calendar_links WHERE event_id=? AND owner=? AND target_id=?',(event_id,self.owner,target_id)).fetchone()
                    if target_id!='internal' and link is None:raise KeyError('Linked calendar event not found')
                    if body.get('revision') and body['revision']!=event['revision']:raise ValueError('Calendar event changed; refresh first')
                    draft=calendar.CalendarDraft.model_validate(body['draft']).model_dump(mode='json') if action=='update' else {k:event[k] for k in ('content','starts_at','timezone_name','reminder_minutes')}
                    op['items'].append({'id':uid(),'event_id':event_id,'revision':event['revision'],'system_id':link['system_id'] if link else event_id,
                                        'status':'queued','draft':draft,'duration_minutes':int(body.get('duration_minutes',event.get('duration_minutes',30))),**({'system_revision':event['system_revision']} if event.get('system_revision') else {})})
            if not op['items']:op['status']='succeeded'
            if len(json.dumps(op,ensure_ascii=False).encode())>1048576:raise ValueError('Calendar batch exceeds 1 MiB; reduce its content or item count')
            count=db.execute("SELECT COUNT(*) FROM calendar_operations WHERE owner=? AND device_id=? AND status IN ('queued','executing','needs_permission','needs_calendar','needs_device','unknown')",(self.owner,op['device_id'])).fetchone()[0]
            if count>=50:raise ValueError('Too many unfinished calendar operations; finish or cancel existing ones first')
            db.execute('INSERT INTO calendar_operations VALUES(?,?,?,?,?,?,?)',(op['id'],self.owner,op['device_id'],op['status'],key,payload_hash,self._metadata(op)))
            self._save_items(db,op)
            return self.public(op)

    def pending(self,device_id,key):
        with self.connect() as db:
            self.schema(db);self.device(db,device_id,key)
            rows=db.execute("SELECT id,status FROM calendar_operations WHERE owner=? AND device_id=? AND status IN ('queued','executing','needs_permission','needs_calendar','needs_device','unknown') ORDER BY rowid LIMIT 100",(self.owner,device_id)).fetchall()
            return [dict(row) for row in rows]

    def authenticate(self,device_id,key):
        with self.connect() as db:
            self.schema(db);self.device(db,device_id,key)

    def claim(self,operation_id,device_id,key):
        with self.connect() as db:
            self.schema(db);device=self.device(db,device_id,key);op=self._operation(db,operation_id)
            if op['device_id']!=device_id:raise PermissionError('Calendar operation belongs to another device')
            if datetime.fromisoformat(op['created_at'])<datetime.now(timezone.utc)-timedelta(days=1) and op['status']=='queued':
                for item in op['items']:item['status']='cancelled'
                return self._save(db,op)
            op.setdefault('token',secrets.token_urlsafe(32))
            if op['status']=='needs_device':return op
            op['status']='needs_permission' if device['permission']!='granted' else 'needs_calendar' if not op['calendar_id'] else 'executing'
            return self._save(db,op)

    def select_calendar(self,operation_id,device_id,key,target_id):
        with self.connect() as db:
            self.schema(db);device=self.device(db,device_id,key);op=self._operation(db,operation_id)
            target=next((row for row in device['targets'] if row['id']==target_id and row['calendar_id']),None)
            if op['device_id']!=device_id or op['status'] not in ('needs_permission','needs_calendar','queued') or op['action']!='create' or not target:
                raise ValueError('Calendar destination cannot be changed')
            op.update(target_id=target['id'],calendar_id=target['calendar_id'],status='queued')
            return self.public(self._save(db,op))

    def receipt(self,operation_id,device_id,key,token,receipt,*,internal=False):
        with self.connect() as db:
            self.schema(db)
            if not internal:self.device(db,device_id,key)
            op=self._operation(db,operation_id)
            if internal and op['device_id']:raise PermissionError('Internal adapter cannot execute system calendar operations')
            if op['device_id']!=device_id or not token or not hmac.compare_digest(op.get('token',''),token):raise PermissionError('Invalid calendar execution ownership')
            item=next((row for row in op['items'] if row['id']==receipt.get('item_id')),None)
            if item is None:raise ValueError('Unknown calendar operation item')
            if internal and (op.get('cancel_requested') or item['status']=='cancelled'):return self.public(op)
            if item['status']=='succeeded':return self.public(op)
            status=receipt.get('status')
            if status not in ('succeeded','failed','unknown'):raise ValueError('Invalid calendar receipt status')
            action=op['action'];verification=receipt.get('verification')
            if status=='succeeded':
                expected='absent' if action=='delete' else 'present'
                if (verification!=expected and not (action=='query' and verification=='absent')) or not receipt.get('system_id'):raise ValueError('A verified system result is required')
                if action!='create' and receipt['system_id']!=item['system_id']:raise ValueError('System calendar identity mismatch')
                if action=='create':
                    draft=item['draft'];now=stamp()
                    event={**draft,'id':item['event_id'],'revision':uid(),'created_at':now,'updated_at':now,
                           'reminder_at':(datetime.fromisoformat(draft['starts_at'])-timedelta(minutes=draft['reminder_minutes'])).isoformat(),
                           'notification_key':uid(),'reminder_status':'system' if device_id else 'pending','reminder_owner':'system' if device_id else 'internal','deliveries':[],
                           'early_reminder_status':'pending','early_deliveries':[],'target_id':op['target_id'],'plan_id':op['plan_id'],
                           'system_revision':receipt.get('system_revision',''),'verified_at':stamp(),'duration_minutes':item['duration_minutes']}
                    db.execute('INSERT INTO digital_calendar(id,starts_at,remind_at,pending,value_json) VALUES(?,?,?,?,?)',(event['id'],datetime.fromisoformat(event['starts_at']).timestamp(),datetime.fromisoformat(event['reminder_at']).timestamp(),not bool(device_id),json.dumps(event,ensure_ascii=False)))
                    day=datetime.fromisoformat(event['starts_at']).astimezone(ZoneInfo(event['timezone_name'])).date().isoformat()
                    db.execute('INSERT INTO calendar_links VALUES(?,?,?,?,?,?,?,?)',(event['id'],self.owner,device_id,op['calendar_id'],op['target_id'],receipt['system_id'],op['plan_id'],day))
                    item['revision']=event['revision']
                else:
                    event=calendar._read(db,item['event_id'],deleted=True)
                    before={key:event.get(key) for key in ('content','starts_at','deleted_at','reminder_minutes','timezone_name')}
                    if event['revision']!=item['revision']:raise ValueError('Calendar mirror changed during execution; reconcile first')
                    if action=='delete' or verification=='absent':event['deleted_at']=stamp()
                    elif action=='update':
                        rescheduled=any(event[key]!=item['draft'][key] for key in ('starts_at','reminder_minutes'))
                        event.update(item['draft'])
                        if rescheduled:
                            event.update(early_reminder_status='pending',early_deliveries=[],notification_key=uid())
                            if not device_id:event.update(reminder_status='pending',deliveries=[])
                        event['reminder_at']=(datetime.fromisoformat(event['starts_at'])-timedelta(minutes=event['reminder_minutes'])).isoformat()
                        db.execute('UPDATE calendar_links SET local_date=? WHERE event_id=?',(datetime.fromisoformat(event['starts_at']).astimezone(ZoneInfo(event['timezone_name'])).date().isoformat(),event['id']))
                    elif action=='query' and isinstance(receipt.get('event'),dict):
                        actual=calendar.CalendarDraft.model_validate(receipt['event']).model_dump(mode='json')
                        event.update(actual)
                        if any(event.get(key)!=before[key] for key in ('starts_at','reminder_minutes')):
                            event.update(early_reminder_status='pending',early_deliveries=[],notification_key=uid())
                        item['draft']=actual
                        event['reminder_at']=(datetime.fromisoformat(event['starts_at'])-timedelta(minutes=event['reminder_minutes'])).isoformat()
                    if action!='query' or any(event.get(key)!=before[key] for key in before):
                        event.update(revision=uid(),updated_at=stamp())
                    event['verified_at']=stamp()
                    if receipt.get('system_revision'):event['system_revision']=str(receipt['system_revision'])[:200]
                    db.execute('UPDATE calendar_links SET local_date=? WHERE event_id=?',(datetime.fromisoformat(event['starts_at']).astimezone(ZoneInfo(event['timezone_name'])).date().isoformat(),event['id']))
                    calendar._save(db,event)
                    item['revision']=event['revision']
                item.update(system_id=receipt['system_id'],verification=verification)
            item.update(status=status,error_code=str(receipt.get('error_code',''))[:80])
            return self.public(self._save(db,op))

    def execute_internal(self,operation_id):
        with self.connect() as db:
            self.schema(db);op=self._operation(db,operation_id)
            if op['device_id']:raise PermissionError('Not an internal calendar operation')
            op.setdefault('token',secrets.token_urlsafe(32));self._save(db,op)
        for item in op['items']:
            if item['status']!='queued':continue
            result=self.receipt(operation_id,'','',op['token'],{'item_id':item['id'],'status':'succeeded',
                                'verification':'absent' if op['action']=='delete' else 'present',
                                'system_id':item.get('system_id') or item['event_id']},internal=True)
            if result.get('cancel_requested'):break
        return self.operation(operation_id)

    def cancel(self,operation_id):
        with self.connect() as db:
            self.schema(db);op=self._operation(db,operation_id);op['cancel_requested']=True
            return self.public(self._save(db,op))

    def wait_device(self,operation_id):
        with self.connect() as db:
            self.schema(db);op=self._operation(db,operation_id)
            if op['status']=='queued':op['status']='needs_device'
            db.execute('UPDATE calendar_operations SET status=?,value_json=? WHERE id=?',(op['status'],self._metadata(op),op['id']))
            return self.public(op)

    def resume(self,operation_id):
        with self.connect() as db:
            self.schema(db);op=self._operation(db,operation_id)
            if op.get('cancel_requested'):raise ValueError('Cancelled operations cannot be resumed')
            for item in op['items']:
                if item['status']=='failed':item['status']='queued'
            op['status']='queued'
            return self.public(self._save(db,op))

    def disconnected(self,device_id):
        with self.connect() as db:
            self.schema(db)
            rows=db.execute("SELECT value_json FROM calendar_operations WHERE owner=? AND device_id=? AND status='executing'",(self.owner,device_id)).fetchall()
            for row in rows:
                op=json.loads(row[0]);op['status']='unknown'
                db.execute('UPDATE calendar_operations SET status=?,value_json=? WHERE id=?',('unknown',json.dumps(op),op['id']))


class DeviceConnections:
    """One bounded, directed notification queue per installation; no calendar polling."""
    def __init__(self):self.clients={}
    def notify(self,owner,device_id,operation_id):
        queue=self.clients.get((owner,device_id))
        if queue and not queue.full():queue.put_nowait({'type':'operation_available','operation_id':operation_id})


connections=DeviceConnections()


def reminder_device(event_id):
    with calendar.connection() as db:
        row=db.execute('SELECT owner,device_id FROM calendar_links WHERE event_id=?',(event_id,)).fetchone()
        return (row['owner'],row['device_id']) if row else None
