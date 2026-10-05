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
        StringBuilder content = new StringBuilder();
        for (String name : new String[]{"main-log.txt", "notification-log.txt"}) {
            content.append("\n==== ").append(name).append(" ====\n");
            try {
                byte[] bytes = Files.readAllBytes(new File(activity.getFilesDir(), name).toPath());
                int start = Math.max(0, bytes.length - 30000);
                content.append(new String(bytes, start, bytes.length - start, StandardCharsets.UTF_8));
            } catch (Exception ignored) {
                content.append("暂无记录\n");
            }
        }
        String logs = content.toString();
        TextView text = new TextView(activity);
        int padding = Math.round(16 * activity.getResources().getDisplayMetrics().density);
        text.setPadding(padding, padding, padding, padding);
        text.setTextIsSelectable(true);
        text.setText(logs);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(text);
        new AlertDialog.Builder(activity)
                .setTitle("WorkStep 日志")
                .setView(scroll)
                .setPositiveButton("复制错误日志", (dialog, which) -> {
                    ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
                    clipboard.setPrimaryClip(ClipData.newPlainText("WorkStep 错误日志",
                            errorLogs(activity.getFilesDir())));
                    Toast.makeText(activity, "错误日志已复制", Toast.LENGTH_SHORT).show();
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

    static String errorLogs(File directory) {
        StringBuilder errors = new StringBuilder();
        for (String name : new String[]{"main-log.txt", "notification-log.txt"}) {
            File file = new File(directory, name);
            if (!file.exists()) continue;
            try {
                String content = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
                for (String entry : content.split("(?m)(?=^\\d{4}-\\d{2}-\\d{2}T)")) {
                    if (entry.isEmpty()) continue;
                    String header = entry.split("\\n", 2)[0];
                    if (!header.matches(".*(失败|异常|错误|崩溃|未显示|无法|断开).*")
                            && !entry.contains("Exception") && !entry.contains("Error")) continue;
                    if (errors.indexOf("==== " + name + " ====") < 0)
                        errors.append("==== ").append(name).append(" ====\n");
                    errors.append(entry);
                    if (!entry.endsWith("\n")) errors.append('\n');
                }
            } catch (Exception ignored) { }
        }
        File crash = new File(directory, FILE_NAME);
        if (crash.exists()) {
            try {
                errors.append("==== ").append(FILE_NAME).append(" ====\n")
                        .append(new String(Files.readAllBytes(crash.toPath()), StandardCharsets.UTF_8));
            } catch (Exception ignored) { }
        }
        return errors.length() == 0 ? "暂无错误日志" : errors.toString();
    }

    static boolean clearFiles(File directory) {
        boolean success = true;
        for (String name : new String[]{"main-log.txt", "notification-log.txt", FILE_NAME}) {
            File file = new File(directory, name);
            if (file.exists() && !file.delete()) success = false;
        }
        return success;
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
