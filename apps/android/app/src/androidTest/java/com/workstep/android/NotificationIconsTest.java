package com.workstep.android;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.os.Bundle;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;

/** Device regression and screenshot fixture; installed only in the test APK. */
public final class NotificationIconsTest extends Instrumentation {
    private String phase;
    private int holdMillis;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        phase = arguments.getString("phase", "test");
        holdMillis = Math.max(0, Math.min(30, Integer.parseInt(arguments.getString("holdSeconds", "0")))) * 1000;
        start();
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private void checkIcons(Context context, Notification notice) {
        int small = context.getResources().getIdentifier("notification_icon", "drawable", context.getPackageName());
        require(small != 0, "Missing branded monochrome notification icon");
        require(notice.getSmallIcon().getResId() == small, "Small icon must use branded arrow glyph");
        require(notice.getLargeIcon() != null && notice.getLargeIcon().getType() == Icon.TYPE_RESOURCE,
                "Card must explicitly reference the color application artwork");
        require(notice.getLargeIcon().getResId() == R.drawable.app_icon, "Stale color notification icon");
        require(context.getApplicationInfo().icon == R.drawable.app_icon, "OEM fallback application icon differs");
        require(notice.getLargeIcon().loadDrawable(context) != null, "Cannot resolve adaptive color icon");
        Bitmap glyph = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
        Drawable drawable = context.getDrawable(small);
        drawable.setBounds(0, 0, 96, 96);
        drawable.draw(new Canvas(glyph));
        int painted = 0;
        for (int y = 0; y < 96; y++) for (int x = 0; x < 96; x++) {
            int pixel = glyph.getPixel(x, y);
            if (Color.alpha(pixel) > 8) {
                painted++;
                // Density interpolation can round RGB at very low premultiplied alpha.
                require(Color.red(pixel) == Color.green(pixel) && Color.green(pixel) == Color.blue(pixel)
                                && (Color.alpha(pixel) < 128 || Color.red(pixel) >= 250),
                        "Notification glyph must be monochrome white: " + Integer.toHexString(pixel) + " at " + x + "," + y);
                require(x > 3 && y > 3 && x < 92 && y < 92, "Glyph must have transparent padding");
            }
        }
        require(painted > 500 && painted < 96 * 96 / 2, "Glyph must have a transparent background");
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        Context context = getTargetContext();
        try {
            CompletionNotifications.createChannels(context);
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.cancelAll();
            context.stopService(new Intent(context, CompletionWatchService.class));
            checkIcons(context, CompletionNotifications.starting(context));
            Notification ongoing = CompletionNotifications.ongoing(context, "http://127.0.0.1/");
            checkIcons(context, ongoing);
            require(ongoing.contentIntent != null && (ongoing.flags & Notification.FLAG_ONGOING_EVENT) != 0,
                    "Waiting notification must preserve pending intent and ongoing state");
            if ("starting".equals(phase)) {
                // Publish the otherwise short-lived onCreate notification for visual inspection.
                manager.notify(7100, CompletionNotifications.starting(context));
            } else if ("waiting".equals(phase)) {
                startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                Intent watch = new Intent(context, CompletionWatchService.class)
                        .putExtra("server", "http://127.0.0.1:9")
                        .putExtra("page", "/")
                        .putExtra("watches", "[{\"id\":\"icon-check\",\"projectId\":\"icon-check\"}]");
                context.startForegroundService(watch);
            } else {
                boolean success = !"failure".equals(phase);
                String title = "test".equals(phase) ? "WorkStep 测试通知"
                        : NotificationContent.title("图标验收", false, success);
                String body = "test".equals(phase) ? "如果能看到这条通知，系统通知权限正常"
                        : NotificationContent.body("图标验收", false, "", success);
                String status = CompletionNotifications.show(context, "icon-" + SystemClock.elapsedRealtime(),
                        title, body, "/", ServerAddress.parse("http://127.0.0.1:9"));
                require("已发送".equals(status), "Notification delivery failed: " + status);
            }
            StatusBarNotification[] active = new StatusBarNotification[0];
            // Android may defer a foreground-service notification for about ten seconds.
            long deadline = SystemClock.elapsedRealtime() + ("waiting".equals(phase) ? 20000 : 5000);
            while (SystemClock.elapsedRealtime() < deadline) {
                active = manager.getActiveNotifications();
                if (active.length == 1) break;
                SystemClock.sleep(100);
            }
            require(active.length == 1, "Expected one visible notification for " + phase);
            Notification notice = active[0].getNotification();
            checkIcons(context, notice);
            if ("waiting".equals(phase)) require((notice.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0,
                    "Waiting fixture must exercise the real foreground service");
            if (!"waiting".equals(phase) && !"starting".equals(phase)) {
                require(notice.contentIntent != null && (notice.flags & Notification.FLAG_AUTO_CANCEL) != 0,
                        "Result notification must preserve click and auto-cancel behavior");
            }
            result.putString("stream", "PASS: " + phase + "; small=" + notice.getSmallIcon()
                    + "; large=" + notice.getLargeIcon() + "; application=" + context.getApplicationInfo().icon + "\n");
            if (holdMillis > 0) {
                sendStatus(1, result);
                // Keep the real service alive while adb captures the notification shade.
                SystemClock.sleep(holdMillis);
            }
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + error + "\n");
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
