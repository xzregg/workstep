package com.workstep.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** A short, on-demand sample from the active WebView, with no network or log writes. */
final class AtlasPerformanceCapture {
    private static final long DURATION_MS = 15000;
    private static final String STOP = "window.__workstepAtlasSample?.(%s) ?? null";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView source;
    private int generation;

    void start(Activity activity, WebView webView) {
        if (source != null) {
            notice(activity, R.string.atlas_sampling);
            return;
        }
        String script;
        try (InputStream asset = activity.getAssets().open("atlas-performance.js")) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            for (int count; (count = asset.read(chunk)) != -1;) buffer.write(chunk, 0, count);
            script = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException error) {
            notice(activity, R.string.atlas_sample_failed);
            return;
        }
        source = webView;
        int session = ++generation;
        Runnable startupTimeout = () -> {
            cancel(true);
            notice(activity, R.string.atlas_sample_failed);
        };
        handler.postDelayed(startupTimeout, 3000);
        webView.evaluateJavascript(script, result -> {
            if (generation != session) return;
            handler.removeCallbacks(startupTimeout);
            if (!"true".equals(result)) {
                source = null;
                notice(activity, R.string.atlas_open_first);
                return;
            }
            notice(activity, R.string.atlas_sampling);
            handler.postDelayed(() -> finish(activity, webView, session), DURATION_MS);
        });
    }

    void cancel(boolean pageStillOpen) {
        WebView previous = source;
        source = null;
        generation++;
        handler.removeCallbacksAndMessages(null);
        if (pageStillOpen && previous != null) previous.evaluateJavascript(String.format(STOP, false), null);
    }

    private void finish(Activity activity, WebView webView, int session) {
        webView.evaluateJavascript(String.format(STOP, true), result -> {
            if (generation != session) return;
            source = null;
            if (result == null || "null".equals(result)) {
                notice(activity, R.string.atlas_sample_failed);
                return;
            }
            try {
                String report = summarize(activity, new JSONObject(result));
                new AlertDialog.Builder(activity)
                        .setTitle(R.string.atlas_sample_title)
                        .setMessage(report)
                        .setNegativeButton(android.R.string.cancel, null)
                        .setPositiveButton(R.string.atlas_copy_sample, (dialog, which) -> {
                            ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
                            clipboard.setPrimaryClip(ClipData.newPlainText(activity.getString(R.string.atlas_sample_title), report));
                            notice(activity, R.string.atlas_copied_sample);
                        })
                        .show();
            } catch (JSONException error) {
                notice(activity, R.string.atlas_sample_failed);
            }
        });
    }

    private static String summarize(Activity activity, JSONObject data) throws JSONException {
        android.content.pm.PackageInfo web = WebView.getCurrentWebViewPackage();
        String reportedBuild = data.optString("build");
        String build = reportedBuild.matches("index-[A-Za-z0-9_-]{1,80}\\.js") ? reportedBuild : "—";
        String path = data.optString("path", "/").replaceAll("[\\p{Cntrl}]", "");
        if (path.length() > 160) path = path.substring(0, 159) + "…";
        JSONArray viewport = data.getJSONArray("viewport");
        String report = CrashReports.version(activity) + "\n"
                + android.os.Build.MODEL + " · Android " + android.os.Build.VERSION.RELEASE + "\n"
                + (web == null ? "WebView" : web.packageName + " " + web.versionName) + "\n"
                + activity.getString(R.string.performance_sample_page, path, build) + "\n"
                + activity.getString(R.string.performance_sample_viewport,
                        viewport.getInt(0), viewport.getInt(1), viewport.getDouble(2), data.getInt("nodes")) + "\n"
                + activity.getString(R.string.atlas_sample_totals,
                        data.getInt("ms"), data.getInt("longTasks"), data.getInt("longTaskMs")) + "\n"
                + summarizeRow(activity, R.string.atlas_sample_idle, data.getJSONArray("idle")) + "\n"
                + summarizeRow(activity, R.string.atlas_sample_touch, data.getJSONArray("touch")) + "\n"
                + summarizeRow(activity, R.string.performance_sample_resources, data.getJSONArray("resources")) + "\n"
                + activity.getString(R.string.performance_sample_heap, data.getInt("heapMiB"));
        JSONObject atlas = data.optJSONObject("atlas");
        if (atlas == null) return report;
        String renderer = switch (atlas.optString("renderer")) {
            case "webgl2" -> "WebGL 2";
            case "canvas2d" -> "Canvas 2D";
            default -> "—";
        };
        return report + "\n" + activity.getString(R.string.atlas_sample_renderer, atlas.getInt("stars"), renderer)
                + "\n" + summarizeRow(activity, R.string.atlas_sample_redraw, atlas.getJSONArray("redraw"))
                + "\n" + summarizeRow(activity, R.string.atlas_sample_particles, atlas.getJSONArray("particles"))
                + "\n" + summarizeRow(activity, R.string.atlas_sample_markers, atlas.getJSONArray("markers"));
    }

    private static String summarizeRow(Activity activity, int label, JSONArray values) throws JSONException {
        return activity.getString(label) + " · " + activity.getString(R.string.atlas_sample_interval,
                values.getInt(0), values.getInt(1), values.getInt(2), values.getInt(3));
    }

    private static void notice(Activity activity, int message) {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
    }
}
