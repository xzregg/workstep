package com.workstep.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;

/** Leaves a short report that the next foreground launch can display without adb. */
final class CrashReports {
    private static final String FILE_NAME = "last-crash.txt";
    private static boolean installed;

    static synchronized void install(Context context, String process) {
        if (installed) return;
        installed = true;
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                log(context, process, "未捕获异常", error);
                StringWriter buffer = new StringWriter();
                error.printStackTrace(new PrintWriter(buffer));
                String report = process + "\n" + buffer;
                Files.write(new File(context.getFilesDir(), FILE_NAME).toPath(),
                        report.substring(0, Math.min(report.length(), 6000)).getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) { }
            if (previous != null) previous.uncaughtException(thread, error);
            else System.exit(1);
        });
    }

    static void log(Context context, String process, String event, Throwable error) {
        try {
            StringBuilder entry = new StringBuilder()
                    .append(Instant.now()).append(' ').append(process).append(' ').append(event).append('\n');
            if (error != null) {
                StringWriter stack = new StringWriter();
                error.printStackTrace(new PrintWriter(stack));
                entry.append(stack);
            }
            File file = new File(context.getFilesDir(), process.equals("后台通知进程")
                    ? "notification-log.txt" : "main-log.txt");
            try (FileOutputStream output = new FileOutputStream(file, file.length() < 65536)) {
                output.write(entry.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) { }
    }

    static void showLogs(Activity activity) {
        String logs = diagnosticSnapshot(activity);
        TextView text = new TextView(activity);
        int padding = Math.round(16 * activity.getResources().getDisplayMetrics().density);
        text.setPadding(padding, padding, padding, padding);
        text.setTextIsSelectable(true);
        text.setText(logs);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(text);
        scroll.post(() -> scroll.fullScroll(android.view.View.FOCUS_DOWN));
        new AlertDialog.Builder(activity)
                .setTitle("WorkStep 排查信息")
                .setView(scroll)
                .setPositiveButton("复制排查信息", (dialog, which) -> {
                    ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
                    clipboard.setPrimaryClip(ClipData.newPlainText("WorkStep 排查信息", diagnosticSnapshot(activity)));
                    Toast.makeText(activity, "排查信息已复制，粘贴给助手即可", Toast.LENGTH_SHORT).show();
                })
                .setNeutralButton(R.string.clear_logs, (dialog, which) ->
                        new AlertDialog.Builder(activity)
                                .setTitle(R.string.clear_logs)
                                .setMessage(R.string.confirm_clear_logs)
                                .setNegativeButton("取消", null)
                                .setPositiveButton(R.string.clear_logs, (confirm, selected) ->
                                        Toast.makeText(activity,
                                                clearFiles(activity.getFilesDir())
                                                        ? R.string.logs_cleared : R.string.logs_clear_failed,
                                                Toast.LENGTH_SHORT).show())
                                .show())
                .setNegativeButton("关闭", null)
                .show();
    }

    private static String diagnosticSnapshot(Activity activity) {
        StringBuilder snapshot = new StringBuilder(version(activity)).append('\n');
        snapshot.append("设备：").append(android.os.Build.MANUFACTURER).append(' ')
                .append(android.os.Build.MODEL).append("；Android ").append(android.os.Build.VERSION.RELEASE)
                .append("；SDK ").append(android.os.Build.VERSION.SDK_INT).append('\n');
        android.content.pm.PackageInfo web = android.webkit.WebView.getCurrentWebViewPackage();
        snapshot.append("WebView：").append(web == null ? "未知" : web.packageName + " " + web.versionName).append('\n');
        android.app.NotificationManager manager = activity.getSystemService(android.app.NotificationManager.class);
        android.app.NotificationChannel channel = manager.getNotificationChannel(CompletionNotifications.CHANNEL_ID);
        snapshot.append("系统通知：").append(manager.areNotificationsEnabled() ? "开启" : "关闭")
                .append("；回复频道：").append(channel == null ? "尚未创建" : channel.getImportance()).append('\n');
        if (activity instanceof MainActivity) snapshot.append("当前页面：")
                .append(((MainActivity) activity).diagnosticPage()).append('\n');
        snapshot.append(DiagnosticReport.create(activity.getFilesDir(), System.currentTimeMillis()));
        return snapshot.toString();
    }

    static boolean clearFiles(File directory) {
        boolean success = true;
        for (String name : new String[]{"main-log.txt", "notification-log.txt", FILE_NAME}) {
            File file = new File(directory, name);
            if (file.exists() && !file.delete()) success = false;
        }
        return success;
    }

    static String version(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            return "WorkStep APK " + info.versionName + " (" + info.getLongVersionCode() + ")";
        } catch (Exception ignored) {
            return "WorkStep APK 版本读取失败";
        }
    }

    static void showIfPresent(Activity activity) {
        File file = new File(activity.getFilesDir(), FILE_NAME);
        if (!file.exists()) return;
        try {
            String report = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            if (!file.delete()) file.deleteOnExit();
            activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                    .setTitle("WorkStep 上次异常")
                    .setMessage(report)
                    .setPositiveButton("复制记录", (dialog, which) -> {
                        ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
                        clipboard.setPrimaryClip(ClipData.newPlainText("WorkStep 崩溃记录", report));
                    })
                    .setNegativeButton("关闭", null)
                    .show());
        } catch (Exception ignored) { }
    }

    private CrashReports() { }
}
