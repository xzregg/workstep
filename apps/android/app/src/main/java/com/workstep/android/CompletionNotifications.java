package com.workstep.android;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import java.util.LinkedHashSet;

final class CompletionNotifications {
    static final String CHANNEL_ID = "workstep_completion";
    static final String WATCH_CHANNEL_ID = "workstep_watch";
    private static final LinkedHashSet<String> delivered = new LinkedHashSet<>();

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID,
                "回复完成与失败", NotificationManager.IMPORTANCE_DEFAULT));
        manager.createNotificationChannel(new NotificationChannel(WATCH_CHANNEL_ID,
                "等待回复结果", NotificationManager.IMPORTANCE_LOW));
    }

    /** Minimal notification used before any logging, networking, or pending-intent setup. */
    static Notification starting(Context context) {
        return new Notification.Builder(context, WATCH_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("WorkStep 正在等待回复")
                .setOngoing(true)
                .build();
    }

    static Notification ongoing(Context context) {
        return ongoing(context, null);
    }

    static Notification ongoing(Context context, String page) {
        createChannels(context);
        Intent open = new Intent(context, MainActivity.class);
        open.setAction(Intent.ACTION_VIEW);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (page != null && !page.isEmpty()) {
            open.setData(Uri.parse(page));
            open.putExtra("notification_page", page);
        }
        PendingIntent pending = PendingIntent.getActivity(context, 7001, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(context, WATCH_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("WorkStep 正在等待回复")
                .setContentText("回复完成或失败时将提醒你")
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    static synchronized String show(Context context, String id, String title, String body,
                                  String page, ServerAddress server) {
        if (id == null || id.isEmpty()) return "缺少通知 ID";
        if (delivered.contains(id)) return "重复事件";
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return "缺少通知权限";
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) return "系统通知已关闭";
        createChannels(context);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE)
            return "回复通知频道已关闭";
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (page != null && page.startsWith("/") && !page.startsWith("//")) {
            String absolute = server.origin() + page;
            if (server.contains(absolute)) {
                intent.setData(Uri.parse(absolute));
                intent.putExtra("notification_page", absolute);
            }
        }
        PendingIntent pending = PendingIntent.getActivity(context, id.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notice = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build();
        manager.notify(id.hashCode(), notice);
        delivered.add(id);
        if (delivered.size() > 1000) delivered.remove(delivered.iterator().next());
        return "已发送";
    }

    private CompletionNotifications() { }
}
