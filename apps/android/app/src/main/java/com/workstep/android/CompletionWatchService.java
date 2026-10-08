package com.workstep.android;

import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;

import okhttp3.OkHttpClient;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Keeps only the active replies' event subscription while the WebView is in background. */
public final class CompletionWatchService extends Service {
    static final String ACTION_STOP = "com.workstep.android.STOP_COMPLETION_WATCH";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final LinkedHashMap<String, JSONObject> watches = new LinkedHashMap<>();
    private final ConnectionRecovery recovery = new ConnectionRecovery();
    private OkHttpClient client;
    private WebSocket socket;
    private ServerAddress server;
    private String cookie;
    private boolean stopped;
    private boolean foregroundReady;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            startForeground(7001, CompletionNotifications.starting(this));
            foregroundReady = true;
        } catch (RuntimeException error) {
            android.util.Log.e("WorkStep", "Cannot start foreground watcher", error);
            CrashReports.log(this, "后台通知进程", "前台服务启动失败", error);
            stopped = true;
            stopSelf();
            return;
        }
        CrashReports.install(this, "后台通知进程");
        CrashReports.log(this, "后台通知进程", "服务创建并进入前台", null);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !foregroundReady) { stopSelf(); return START_NOT_STICKY; }
        if (ACTION_STOP.equals(intent.getAction())) {
            stopped = true;
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            server = ServerAddress.parse(intent.getStringExtra("server"));
            cookie = intent.getStringExtra("cookie");
            applyWatches(intent.getStringExtra("watches"));
            startForeground(7001, CompletionNotifications.ongoing(this,
                    server.pageOrRoot(intent.getStringExtra("page"))));
        } catch (Exception error) {
            CrashReports.log(this, "后台通知进程", "启动参数无效", error);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (watches.isEmpty()) { stopSelf(); return START_NOT_STICKY; }
        CrashReports.log(this, "后台通知进程", "服务启动；监听数量=" + watches.size(), null);
        stopped = false;
        recovery.connected();
        try {
            client = new OkHttpClient.Builder().pingInterval(
                    20, java.util.concurrent.TimeUnit.SECONDS).build();
            connect();
        } catch (RuntimeException error) {
            android.util.Log.e("WorkStep", "Cannot connect completion watcher", error);
            CrashReports.log(this, "后台通知进程", "连接初始化失败", error);
            stopped = true;
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void applyWatches(String json) {
        try {
            JSONArray items = new JSONArray(json);
            watches.clear();
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.getJSONObject(i);
                String id = item.optString("id");
                if (!id.isEmpty()) watches.put(id, item);
            }
            if (watches.isEmpty()) {
                stopped = true;
                stopSelf();
            }
            else if (socket != null) subscribe(socket);
        } catch (Exception ignored) { }
    }

    private void connect() {
        if (stopped || server == null || watches.isEmpty()) return;
        try {
            if (socket != null) socket.cancel();
            String address = server.origin().replaceFirst("^http", "ws") + "/ws";
            Request.Builder request = new Request.Builder().url(address);
            if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
            socket = client.newWebSocket(request.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                handler.post(() -> {
                    if (socket == webSocket && !stopped) {
                        CrashReports.log(CompletionWatchService.this, "后台通知进程",
                                recovery.connected() ? "WebSocket 重连成功" : "WebSocket 已连接", null);
                        subscribe(webSocket);
                    }
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                handler.post(() -> { if (socket == webSocket && !stopped) receive(text, false); });
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                retry(webSocket, error);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                retry(webSocket, new IOException("WebSocket closed: " + code + " " + reason));
            }
            });
        } catch (RuntimeException error) {
            socket = null;
            scheduleReconnect(error);
        }
    }

    private void retry(WebSocket previous, Throwable error) {
        handler.post(() -> {
            if (socket != previous || stopped) return;
            socket = null;
            scheduleReconnect(error);
        });
    }

    private void scheduleReconnect(Throwable error) {
        if (stopped || watches.isEmpty()) return;
        if (recovery.failed()) {
            CrashReports.log(this, "后台通知进程", "WebSocket 重连失败；将继续每5秒重试", error);
        } else {
            CrashReports.log(this, "后台通知进程", "WebSocket 连接中断，5秒后重试", null);
        }
        handler.postDelayed(this::connect, 5000);
    }

    private void subscribe(WebSocket target) {
        try {
            LinkedHashSet<String> sessions = new LinkedHashSet<>();
            LinkedHashSet<String> tasks = new LinkedHashSet<>();
            String projectId = "";
            for (JSONObject watch : watches.values()) {
                if (projectId.isEmpty()) projectId = watch.optString("projectId");
                String sessionId = NotificationIds.value(watch.optString("sessionId"));
                String taskId = NotificationIds.value(watch.optString("taskId"));
                if (!sessionId.isEmpty()) sessions.add(sessionId);
                if (!taskId.isEmpty()) tasks.add(taskId);
            }
            target.send(new JSONObject().put("type", "subscribe")
                    .put("project_id", projectId)
                    .put("session_ids", new JSONArray(sessions))
                    .put("task_ids", new JSONArray(tasks)).toString());
            CrashReports.log(this, "后台通知进程", "已订阅；会话=" + sessions.size() + "，任务=" + tasks.size(), null);
            fetchRecent(target, projectId);
        } catch (Exception | LinkageError error) {
            CrashReports.log(this, "后台通知进程", "订阅失败", error);
        }
    }

    private void fetchRecent(WebSocket target, String projectId) {
        String url = server.origin() + "/api/completion-notifications/recent?project_id="
                + Uri.encode(projectId);
        Request.Builder request = new Request.Builder().url(url);
        if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
        client.newCall(request.build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException error) {
                CrashReports.log(CompletionWatchService.this, "后台通知进程", "补查近期结果失败", error);
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                try (Response result = response) {
                    if (!result.isSuccessful() || result.body() == null) {
                        CrashReports.log(CompletionWatchService.this, "后台通知进程",
                                "补查近期结果返回 HTTP " + result.code(), null);
                        return;
                    }
                    JSONArray events = new JSONObject(result.body().string()).optJSONArray("events");
                    if (events == null) return;
                    CrashReports.log(CompletionWatchService.this, "后台通知进程",
                            "补查近期结果；数量=" + events.length(), null);
                    for (int i = 0; i < events.length(); i++) {
                        String event = events.getJSONObject(i).toString();
                        handler.post(() -> {
                            if (socket == target && !stopped) receive(event, true);
                        });
                    }
                } catch (Exception error) {
                    CrashReports.log(CompletionWatchService.this, "后台通知进程", "解析近期结果失败", error);
                }
            }
        });
    }

    private void receive(String text, boolean replay) {
        try {
            JSONObject event = new JSONObject(text);
            String type = event.optString("type");
            String status = event.optString("status");
            String sessionId = NotificationIds.value(event.optString("session_id"));
            String taskId = "session_chat".equals(event.optString("channel")) && !sessionId.isEmpty()
                    ? "" : NotificationIds.value(event.optString("task_id"));
            boolean step = ("RUN_FINISHED".equals(type) && "passed".equals(status))
                    || ("RUN_ERROR".equals(type) && "failed".equals(status));
            if (!step && !"TEXT_MESSAGE_END".equals(type)) return;
            String watchId = step
                    ? event.optString("project_id") + ":" + taskId + ":step:" + event.optString("step_key")
                    : event.optString("project_id") + ":" +
                    (!sessionId.isEmpty() ? sessionId : taskId)
                    + ":" + event.optString("messageId");
            JSONObject watch = watches.remove(watchId);
            if (!step) {
                String project = event.optString("project_id");
                JSONObject pendingSession = sessionId.isEmpty() ? null
                        : takePending(project + ":" + sessionId + ":pending", event, replay);
                JSONObject pendingTask = taskId.isEmpty() ? null
                        : takePending(project + ":" + taskId + ":pending", event, replay);
                if (watch == null) watch = pendingSession != null ? pendingSession : pendingTask;
            }
            if (watch == null) return;
            CrashReports.log(this, "后台通知进程", "匹配结果；类型=" + type + "，状态=" + status, null);
            if (step || "succeeded".equals(status) || "failed".equals(status) || "error".equals(status)) {
                boolean success = "succeeded".equals(status) || "passed".equals(status);
                String id = step ? watchId + ":" + event.optString("sequence", status) : watchId;
                String destination = NotificationDestination.path(watch.optString("url"),
                        sessionId, taskId,
                        event.optString("channel"));
                boolean taskReply = !taskId.isEmpty();
                String name = NotificationContent.name(watch.optString("scopeName"), sessionId, taskId);
                String result = CompletionNotifications.show(this, id,
                        NotificationContent.title(name, step, success),
                        NotificationContent.body(name, taskReply, step ? event.optString("step_key") : "", success),
                        destination, server);
                CrashReports.log(this, "后台通知进程", "系统通知：" + result + "；目标=" + destination, null);
            }
            if (watches.isEmpty()) {
                stopped = true;
                stopSelf();
            }
        } catch (Exception error) {
            CrashReports.log(this, "后台通知进程", "处理结果失败", error);
        }
    }

    private JSONObject takePending(String id, JSONObject event, boolean replay) {
        JSONObject pending = watches.get(id);
        if (pending == null || !CompletionWatchMatch.pending(replay,
                event.optDouble("recorded_at", 0), pending.optLong("startedAt", 0))) return null;
        return watches.remove(id);
    }

    @Override
    public void onDestroy() {
        CrashReports.log(this, "后台通知进程", "服务停止；剩余监听=" + watches.size(), null);
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        if (socket != null) socket.cancel();
        if (client != null) client.dispatcher().executorService().shutdown();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
