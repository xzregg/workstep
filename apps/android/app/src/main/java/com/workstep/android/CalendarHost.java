package com.workstep.android;

import android.Manifest;
import android.app.Activity;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.provider.CalendarContract;
import android.provider.Settings;
import androidx.webkit.JavaScriptReplyProxy;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Only registered by MainActivity on its trusted main frame. Provider I/O never runs on UI. */
final class CalendarHost {
    static final int PERMISSION_REQUEST = 1017;
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static SQLiteDatabase ledgerDatabase;
    private final Activity activity;
    private final SharedPreferences preferences;
    private JavaScriptReplyProxy permissionReply;
    private String permissionId;
    CalendarHost(Activity activity) {
        this.activity=activity;
        preferences=activity.getSharedPreferences("native_calendar",Activity.MODE_PRIVATE);
    }
    private boolean granted() {
        return activity.checkSelfPermission(Manifest.permission.READ_CALENDAR)==PackageManager.PERMISSION_GRANTED
            && activity.checkSelfPermission(Manifest.permission.WRITE_CALENDAR)==PackageManager.PERMISSION_GRANTED;
    }
    private static String hash(String text) throws Exception {
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder value=new StringBuilder();for(byte b:digest)value.append(String.format("%02x",b));return value.toString();
    }
    private void reply(JavaScriptReplyProxy callback,String id,JSONObject result,String error) {
        activity.runOnUiThread(()->{try {
            JSONObject value=new JSONObject().put("id",id);
            if(error!=null)value.put("error",error);else value.put("result",result);
            callback.postMessage(value.toString());
        } catch(Exception ignored) { /* Frame may have closed; durable execution result is retained. */ }});
    }
    void handle(String raw,JavaScriptReplyProxy callback) {
        try {
            if(raw==null||raw.length()>240000)throw new IllegalArgumentException();
            JSONObject message=new JSONObject(raw);String id=message.getString("id"),action=message.getString("action");
            JSONObject value=message.optJSONObject("value");if(value==null)value=new JSONObject();
            if(action.equals("permission")) {
                if(granted()){worker.execute(()->{try{reply(callback,id,status(),null);}catch(Exception e){reply(callback,id,null,"provider_error");}});return;}
                if(permissionReply!=null){reply(callback,id,null,"permission_request_in_progress");return;}
                permissionReply=callback;permissionId=id;
                preferences.edit().putBoolean("permission_asked",true).apply();
                activity.runOnUiThread(()->activity.requestPermissions(new String[]{Manifest.permission.READ_CALENDAR,Manifest.permission.WRITE_CALENDAR},PERMISSION_REQUEST));return;
            }
            if(action.equals("settings")) {
                activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+activity.getPackageName())));
                reply(callback,id,new JSONObject(),null);return;
            }
            JSONObject input=value;
            worker.execute(()->{try{reply(callback,id,invoke(action,input),null);}catch(Exception error){reply(callback,id,null,"provider_error");}});
        }catch(Exception error){reply(callback,"",null,"invalid_request");}
    }
    void permissionResult() {
        JavaScriptReplyProxy callback=permissionReply;String id=permissionId;permissionReply=null;permissionId=null;
        if(callback!=null)worker.execute(()->{try{reply(callback,id,status(),null);}catch(Exception error){reply(callback,id,null,"provider_error");}});
    }
    private JSONObject status() throws Exception {
        boolean access=granted();JSONArray calendars=new JSONArray();
        if(access)try(Cursor cursor=activity.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI,
            new String[]{"_id","calendar_displayName"},"calendar_access_level>=?",new String[]{String.valueOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)},null)) {
            if(cursor==null)throw new IllegalStateException("Calendar unavailable");
            while(cursor.moveToNext()&&calendars.length()<100)calendars.put(new JSONObject().put("id",cursor.getString(0)).put("name",cursor.getString(1)));
        }
        boolean asked=preferences.getBoolean("permission_asked",false);
        return new JSONObject().put("permission",access?"granted":asked?"denied":"not_determined").put("calendars",calendars);
    }
    private JSONObject invoke(String action,JSONObject input) throws Exception {
        String namespace=input.getString("namespace");if(namespace.length()>1000)throw new IllegalArgumentException();
        if(action.equals("events"))return events(namespace,input);
        String key=hash(namespace);JSONObject state=load(key);
        if(action.equals("identity")) {
            if(!state.has("device_id")){state.put("device_id",UUID.randomUUID().toString()).put("key",UUID.randomUUID().toString()+UUID.randomUUID());save(key,state);}
            return new JSONObject().put("device_id",state.getString("device_id")).put("key",state.getString("key")).put("name",android.os.Build.MODEL).put("platform","android");
        }
        if(action.equals("status")||action.equals("calendars"))return status();
        if(!action.equals("execute")||!state.has("device_id"))throw new IllegalArgumentException();
        JSONObject operation=input.getJSONObject("operation"),item=input.getJSONObject("item");String itemId=item.getString("id");
        String fingerprint=hash(operation.getString("id")+":"+operation.getString("action")+":"+operation.getString("calendar_id")+":"+itemId+":"+item.getJSONObject("draft").toString()+":"+item.optString("revision")+":"+item.optInt("duration_minutes",30));
        String ledgerKey=key+":item:"+itemId;
        JSONObject previous=load(ledgerKey);if(previous.length()==0)previous=null;
        if(previous!=null) {
            if(!fingerprint.equals(previous.getString("fingerprint")))throw new IllegalArgumentException("Idempotency conflict");
            if(previous.has("result")&&previous.getJSONObject("result").optString("status").equals("succeeded"))return previous.getJSONObject("result");
            if(previous.optString("phase").equals("unknown")&&operation.getString("action").equals("create")){
                JSONObject result=provider("query_created",operation.getString("calendar_id"),item).put("item_id",itemId);
                if(result.optString("status").equals("succeeded")){
                    save(key+":event:"+result.getString("system_id"),new JSONObject().put("calendar_id",operation.getString("calendar_id")));
                    save(ledgerKey,new JSONObject().put("fingerprint",fingerprint).put("phase","succeeded").put("result",result));
                }
                return result;
            }
        }
        if(!granted())return new JSONObject().put("item_id",itemId).put("status","failed").put("error_code","permission_required");
        String systemId=item.optString("system_id"),calendarId=operation.getString("calendar_id");
        if(!operation.getString("action").equals("create")&&!calendarId.equals(load(key+":event:"+systemId).optString("calendar_id")))throw new IllegalArgumentException("Unowned calendar event");
        save(ledgerKey,new JSONObject().put("fingerprint",fingerprint).put("phase","unknown"));
        JSONObject result;
        try {result=provider(operation.getString("action"),calendarId,item);}
        catch(Exception error){result=new JSONObject().put("status","unknown").put("error_code","verification_unknown");}
        result.put("item_id",itemId);
        if(result.optString("status").equals("succeeded")&&operation.getString("action").equals("create"))save(key+":event:"+result.getString("system_id"),new JSONObject().put("calendar_id",calendarId));
        save(ledgerKey,new JSONObject().put("fingerprint",fingerprint).put("phase",result.getString("status")).put("result",result));
        return result;
    }
    static boolean validReadWindow(long since,long before) {
        return since>=0&&before>since&&before-since<=62L*86400000;
    }
    private JSONObject events(String namespace,JSONObject input) throws Exception {
        if(!granted())throw new SecurityException("permission_required");
        long since=OffsetDateTime.parse(input.getString("since")).toInstant().toEpochMilli();
        long before=OffsetDateTime.parse(input.getString("before")).toInstant().toEpochMilli();
        if(!validReadWindow(since,before))throw new IllegalArgumentException("invalid_calendar_window");
        Uri.Builder uri=CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(uri,since);ContentUris.appendId(uri,before);
        JSONArray items=new JSONArray();boolean more=false;
        String key=hash(namespace);
        try(Cursor rows=activity.getContentResolver().query(uri.build(),new String[]{CalendarContract.Instances.EVENT_ID,CalendarContract.Instances.BEGIN,
            CalendarContract.Events.TITLE,CalendarContract.Events.DESCRIPTION,CalendarContract.Events.EVENT_TIMEZONE,CalendarContract.Events.ALL_DAY,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME},CalendarContract.Calendars.VISIBLE+"=1",null,CalendarContract.Instances.BEGIN+" ASC")) {
            if(rows==null)throw new IllegalStateException("Calendar query failed");
            while(rows.moveToNext()){
                if(items.length()>=200){more=true;break;}
                String id=rows.getString(0),content=rows.isNull(3)||rows.getString(3).isEmpty()?rows.getString(2):rows.getString(3);
                if(content==null)content="";
                boolean truncated=content.length()>2000;
                items.put(new JSONObject().put("system_id",id).put("starts_at",java.time.Instant.ofEpochMilli(rows.getLong(1)).toString())
                    .put("content",content.substring(0,Math.min(content.length(),2000))).put("content_truncated",truncated)
                    .put("timezone_name",rows.isNull(4)?"UTC":rows.getString(4)).put("all_day",rows.getInt(5)!=0)
                    .put("calendar_name",rows.isNull(6)?"":rows.getString(6)).put("workstep_owned",load(key+":event:"+id).length()>0));
            }
        }
        return new JSONObject().put("items",items).put("has_more",more);
    }
    private void save(String key,JSONObject state) {
        ContentValues values=new ContentValues();values.put("key",key);values.put("value",state.toString());
        if(database().insertWithOnConflict("checkpoint",null,values,SQLiteDatabase.CONFLICT_REPLACE)<0)throw new IllegalStateException("Calendar checkpoint failed");
    }
    private SQLiteDatabase database(){
        if(ledgerDatabase==null){
            java.io.File file=activity.getApplicationContext().getDatabasePath("native_calendar.db");file.getParentFile().mkdirs();
            ledgerDatabase=SQLiteDatabase.openOrCreateDatabase(file,null);ledgerDatabase.enableWriteAheadLogging();
            ledgerDatabase.execSQL("CREATE TABLE IF NOT EXISTS checkpoint (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
        }
        return ledgerDatabase;
    }
    private JSONObject load(String key) throws Exception {
        try(Cursor row=database().query("checkpoint",new String[]{"value"},"key=?",new String[]{key},null,null,null)){
            return row.moveToFirst()?new JSONObject(row.getString(0)):new JSONObject();
        }
    }
    private JSONObject read(String systemId,String calendarId) throws Exception {
        try(Cursor cursor=activity.getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,Long.parseLong(systemId)),
            new String[]{"calendar_id","title","description","dtstart","dtend","rrule","deleted","eventTimezone"},null,null,null)) {
            if(cursor==null)throw new IllegalStateException("Calendar query failed");
            if(!cursor.moveToFirst()||cursor.getInt(6)==1)return null;
            if(!calendarId.equals(cursor.getString(0))||!cursor.isNull(5)&&!cursor.getString(5).isEmpty())throw new IllegalStateException("Calendar event changed");
            String version=hash(cursor.getString(1)+"\u0000"+cursor.getString(2)+"\u0000"+cursor.getLong(3)+"\u0000"+cursor.getLong(4));
            int minutes=0;boolean reminderPresent=false;
            try(Cursor reminders=activity.getContentResolver().query(CalendarContract.Reminders.CONTENT_URI,new String[]{"minutes"},"event_id=?",new String[]{systemId},null)){
                if(reminders==null)throw new IllegalStateException();if(reminders.moveToFirst()){minutes=Math.max(0,reminders.getInt(0));reminderPresent=true;}
            }
            return new JSONObject().put("system_revision",hash(version+":"+minutes+":"+reminderPresent)).put("content",cursor.isNull(2)||cursor.getString(2).isEmpty()?cursor.getString(1):cursor.getString(2)).put("starts_at",cursor.getLong(3)).put("timezone_name",cursor.isNull(7)?"UTC":cursor.getString(7)).put("reminder_minutes",minutes).put("reminder_present",reminderPresent);
        }
    }
    private JSONObject provider(String action,String calendarId,JSONObject item) throws Exception {
        boolean writable=false;JSONArray calendars=status().getJSONArray("calendars");
        for(int i=0;i<calendars.length();i++)if(calendars.getJSONObject(i).getString("id").equals(calendarId))writable=true;
        if(!writable)return new JSONObject().put("status","failed").put("error_code","calendar_unavailable");
        if(action.equals("query_created")){
            try(Cursor cursor=activity.getContentResolver().query(CalendarContract.Events.CONTENT_URI,new String[]{"_id"},"calendar_id=? AND customAppUri=? AND deleted=0",new String[]{calendarId,"workstep://calendar/item/"+item.getString("id")},null)){
                if(cursor!=null&&cursor.getCount()==1&&cursor.moveToFirst()){
                    String id=cursor.getString(0);JSONObject checked=read(id,calendarId);
                    JSONObject expected=item.getJSONObject("draft");
                    if(checked!=null&&checked.getBoolean("reminder_present")&&checked.getInt("reminder_minutes")==expected.optInt("reminder_minutes",0)&&checked.getString("content").equals(expected.getString("content")))return new JSONObject().put("status","succeeded").put("verification","present").put("system_id",id).put("system_revision",checked.getString("system_revision"));
                }
            }
            return new JSONObject().put("status","unknown").put("error_code","verification_unknown");
        }
        String systemId=item.optString("system_id");JSONObject existing=systemId.isEmpty()?null:read(systemId,calendarId);
        if(!action.equals("create")&&!action.equals("query")&&existing!=null&&item.has("system_revision")&&!item.getString("system_revision").equals(existing.getString("system_revision")))return new JSONObject().put("status","failed").put("error_code","conflict");
        if(action.equals("query")){
            JSONObject result=new JSONObject().put("status","succeeded").put("verification",existing==null?"absent":"present").put("system_id",systemId).put("system_revision",existing==null?"":existing.getString("system_revision"));
            if(existing!=null)result.put("event",new JSONObject().put("content",existing.getString("content")).put("starts_at",java.time.Instant.ofEpochMilli(existing.getLong("starts_at")).toString()).put("timezone_name",existing.getString("timezone_name")).put("reminder_minutes",existing.getInt("reminder_minutes")));
            return result;
        }
        if(action.equals("delete")) {
            if(existing!=null)activity.getContentResolver().delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,Long.parseLong(systemId)),null,null);
            boolean absent=read(systemId,calendarId)==null;
            return new JSONObject().put("status",absent?"succeeded":"unknown").put("verification","absent").put("system_id",systemId);
        }
        if(!action.equals("create")&&!action.equals("update"))throw new IllegalArgumentException();
        if(action.equals("update")&&existing==null)return new JSONObject().put("status","failed").put("error_code","conflict");
        JSONObject draft=item.getJSONObject("draft");String content=draft.getString("content");if(content.trim().isEmpty()||content.length()>20000)throw new IllegalArgumentException();
        long start=OffsetDateTime.parse(draft.getString("starts_at")).toInstant().toEpochMilli();
        int duration=item.optInt("duration_minutes",30);if(duration<1||duration>10080)throw new IllegalArgumentException();
        String title=content.split("\n",2)[0].replaceAll("[#*`_>]","").trim();
        ContentValues values=new ContentValues();values.put("calendar_id",Long.parseLong(calendarId));values.put("title",title.substring(0,Math.min(title.length(),80)));
        values.put("description",content);values.put("dtstart",start);values.put("dtend",start+duration*60000L);values.put("eventTimezone",draft.getString("timezone_name"));values.put("hasAlarm",1);
        ArrayList<ContentProviderOperation> batch=new ArrayList<>();
        if(action.equals("create")) {
            values.put("customAppUri","workstep://calendar/item/"+item.getString("id"));values.put("customAppPackage",activity.getPackageName());
            batch.add(ContentProviderOperation.newInsert(CalendarContract.Events.CONTENT_URI).withValues(values).build());
            batch.add(ContentProviderOperation.newInsert(CalendarContract.Reminders.CONTENT_URI).withValueBackReference("event_id",0).withValue("minutes",draft.optInt("reminder_minutes",0)).withValue("method",CalendarContract.Reminders.METHOD_ALERT).build());
        }else{
            batch.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,Long.parseLong(systemId))).withValues(values).build());
            batch.add(ContentProviderOperation.newDelete(CalendarContract.Reminders.CONTENT_URI).withSelection("event_id=?",new String[]{systemId}).build());
            batch.add(ContentProviderOperation.newInsert(CalendarContract.Reminders.CONTENT_URI).withValue("event_id",Long.parseLong(systemId)).withValue("minutes",draft.optInt("reminder_minutes",0)).withValue("method",CalendarContract.Reminders.METHOD_ALERT).build());
        }
        ContentProviderResult[] applied=activity.getContentResolver().applyBatch(CalendarContract.AUTHORITY,batch);
        if(action.equals("create")){if(applied[0].uri==null)throw new IllegalStateException();systemId=applied[0].uri.getLastPathSegment();}
        JSONObject checked=read(systemId,calendarId);
        if(checked==null||!content.equals(checked.getString("content"))||start!=checked.getLong("starts_at")||!checked.getBoolean("reminder_present")||checked.getInt("reminder_minutes")!=draft.optInt("reminder_minutes",0))throw new IllegalStateException();
        return new JSONObject().put("status","succeeded").put("verification","present").put("system_id",systemId).put("system_revision",checked.getString("system_revision"));
    }
}
