package com.workstep.android;

import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Bundled, offline diagnostics view. The remote workbench never receives the local bridge. */
final class RuntimeDiagnostics {
    private static final int SAVE_REQUEST = 1027;
    private static final int REPORT_LIMIT = 2 * 1024 * 1024;
    private static final String BASE = "https://appassets.androidplatform.net/runtime-diagnostics/";
    private static final String HOME = BASE + "runtime-diagnostics.html";
    private static final List<String> ASSETS = Arrays.asList(HOME, BASE + "runtime-diagnostics.js",
            BASE + "runtime-diagnostics-view.js", BASE + "runtime-diagnostics-native.js", BASE + "runtime-diagnostics.css");

    private final Activity activity;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Supplier<WebView> workbench;
    private final Supplier<String> origin;
    private final Runnable beforePicker;
    private final Handler timer = new Handler(Looper.getMainLooper());
    private Dialog dialog;
    private WebView viewer;
    private WebView recording;
    private JSONObject latest;
    private int generation;
    private Save pendingSave;

    private static final class Save {
        final WebView view;
        final int id;
        final byte[] bytes;
        Save(WebView view, int id, byte[] bytes) { this.view = view; this.id = id; this.bytes = bytes; }
    }

    RuntimeDiagnostics(Activity activity, Supplier<WebView> workbench,
                       Supplier<String> origin, Runnable beforePicker) {
        this.activity = activity;
        this.workbench = workbench;
        this.origin = origin;
        this.beforePicker = beforePicker;
    }

    void open() {
        if (viewer != null) return;
        WebView view = new WebView(activity);
        viewer = view;
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/runtime-diagnostics/", new WebViewAssetLoader.AssetsPathHandler(activity))
                .build();
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView sender, WebResourceRequest request) {
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView sender, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (ASSETS.contains(url) && (!request.isForMainFrame() || HOME.equals(url))) {
                    // The asset loader strips the registered prefix before looking up the file.
                    WebResourceResponse asset = loader.shouldInterceptRequest(request.getUrl());
                    if (asset != null) return asset;
                }
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
        });
        view.addJavascriptInterface(new Bridge(view), "androidRuntimeDiagnostics");
        dialog = new Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar);
        dialog.setContentView(view);
        dialog.setOnDismissListener(unused -> {
            if (viewer != view) return;
            viewer = null;
            dialog = null;
            view.removeJavascriptInterface("androidRuntimeDiagnostics");
            view.stopLoading();
            view.destroy();
        });
        view.loadUrl(HOME);
        dialog.show();
    }

    void close() { if (dialog != null) dialog.dismiss(); }

    void destroy() {
        navigation();
        close();
        io.shutdownNow();
    }

    private final class Bridge {
        private final WebView view;
        Bridge(WebView view) { this.view = view; }
        @JavascriptInterface public void invoke(int id, String action, String value) {
            activity.runOnUiThread(() -> {
                if (viewer != view || !HOME.equals(view.getUrl())) return;
                try {
                    switch (action) {
                        case "status" -> reply(view, id, status(), false);
                        case "read" -> read(view, id);
                        case "start" -> start(view, id);
                        case "stop" -> { stop("manual", () -> reply(view, id, true, false)); }
                        case "copy" -> copyReport(view, id, value);
                        case "save" -> save(view, id, value);
                        case "manage" -> {
                            reply(view, id, true, false);
                            CrashReports.showLogs(activity);
                        }
                        default -> reply(view, id, JSONObject.NULL, true);
                    }
                } catch (Exception error) { reply(view, id, JSONObject.NULL, true); }
            });
        }
    }

    private JSONObject status() throws JSONException {
        JSONObject performance = new JSONObject().put("recording", recording != null)
                .put("result", latest == null ? JSONObject.NULL : latest);
        android.content.pm.PackageInfo web = WebView.getCurrentWebViewPackage();
        JSONObject environment = new JSONObject().put("platform", "android").put("version", CrashReports.version(activity))
                .put("os", "Android " + android.os.Build.VERSION.RELEASE)
                .put("runtime", web == null ? "WebView" : web.packageName + " " + web.versionName);
        return new JSONObject().put("available", workbench.get() != null).put("performance", performance)
                .put("environment", environment);
    }

    private void read(WebView view, int id) throws JSONException {
        JSONObject state = status();
        WebView page = workbench.get();
        if (page == null) { readFiles(view, id, state, null); return; }
        page.evaluateJavascript(sameOrigin("window.workstepRuntimeLogSnapshot?.() ?? []"),
                result -> readFiles(view, id, state, page == workbench.get() ? result : null));
    }

    private void readFiles(WebView view, int id, JSONObject state, String browser) {
        io.execute(() -> {
            JSONArray streams = new JSONArray();
            try {
                appendFile(streams, "android", "main-log.txt");
                appendFile(streams, "notification", "notification-log.txt");
                appendFile(streams, "crash", "last-crash.txt");
                if (browser != null && browser.startsWith("[") && browser.length() < 512 * 1024) {
                    JSONArray entries = new JSONArray(browser);
                    for (String source : new String[]{"page", "request"}) {
                        StringBuilder text = new StringBuilder();
                        for (int index = 0; index < Math.min(100, entries.length()); index++) {
                            JSONObject entry = entries.optJSONObject(index);
                            if (entry == null || !source.equals(entry.optString("kind"))) continue;
                            String at = entry.optString("at");
                            if (!at.matches("\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z")) continue;
                            String level = entry.optString("level");
                            if (!"error".equals(level) && !"warn".equals(level)) level = "info";
                            String detail = entry.optString("detail");
                            text.append(at).append(' ').append(level).append(' ')
                                    .append(detail, 0, Math.min(detail.length(), 2048)).append('\n');
                        }
                        streams.put(new JSONObject().put("source", source).put("text", text.toString()));
                    }
                }
                state.put("streams", streams);
                state.put("warning", "远端后台日志请在服务主机查看");
                activity.runOnUiThread(() -> reply(view, id, state, false));
            } catch (Exception error) { activity.runOnUiThread(() -> reply(view, id, JSONObject.NULL, true)); }
        });
    }

    private void appendFile(JSONArray streams, String source, String name) throws Exception {
        File file = new File(activity.getFilesDir(), name);
        if (!file.isFile()) return;
        String text;
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            long length = input.length();
            byte[] buffer = new byte[(int) Math.min(128 * 1024, length)];
            input.seek(length - buffer.length);
            int count = input.read(buffer);
            text = count > 0 ? new String(buffer, 0, count, StandardCharsets.UTF_8) : "";
        }
        if (source.equals("crash")) text = Instant.ofEpochMilli(file.lastModified()) + " ERROR 崩溃\n" + text;
        streams.put(new JSONObject().put("source", source).put("text", text));
    }

    private void start(WebView view, int id) {
        WebView page = workbench.get();
        if (page == null || recording != null) { reply(view, id, false, false); return; }
        int epoch = ++generation;
        io.execute(() -> {
            try (InputStream asset = activity.getAssets().open("runtime-diagnostics.js")) {
                String script = readRecordingScript(asset);
                activity.runOnUiThread(() -> {
                    if (viewer != view || page != workbench.get() || epoch != generation) {
                        reply(view, id, false, false);
                        return;
                    }
                    page.evaluateJavascript(sameOrigin("(() => {" + script + "\nreturn window.workstepPerformance.start()})()"), result -> {
                        if (epoch != generation || page != workbench.get() || !"true".equals(result)) {
                            reply(view, id, false, false);
                            return;
                        }
                        latest = null;
                        recording = page;
                        timer.postDelayed(() -> stop("timeout", null), 15100);
                        android.widget.Toast.makeText(activity, "正在录制，长按悬浮球可查看或停止", android.widget.Toast.LENGTH_SHORT).show();
                        reply(view, id, true, false);
                        close();
                    });
                });
            } catch (Exception error) { activity.runOnUiThread(() -> reply(view, id, false, true)); }
        });
    }

    static String readRecordingScript(InputStream input) throws IOException {
        ByteArrayOutputStream script = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        for (int count; (count = input.read(buffer)) != -1;) {
            script.write(buffer, 0, count);
        }
        return new String(script.toByteArray(), StandardCharsets.UTF_8);
    }

    private String sameOrigin(String expression) {
        return "location.origin === " + JSONObject.quote(origin.get()) + " ? (" + expression + ") : null";
    }

    void stop(String reason, Runnable done) {
        WebView page = recording;
        if (page == null) { generation++; if (done != null) done.run(); return; }
        recording = null;
        int epoch = ++generation;
        timer.removeCallbacksAndMessages(null);
        if (page != workbench.get()) { if (done != null) done.run(); return; }
        page.evaluateJavascript(sameOrigin("window.workstepPerformance?.stop(" + JSONObject.quote(reason) + ") ?? null"), value -> {
            if (epoch == generation && value != null && value.startsWith("{")) {
                try { latest = new JSONObject(value); } catch (JSONException ignored) { }
            }
            if (done != null) done.run();
        });
    }

    void navigation() { generation++; recording = null; timer.removeCallbacksAndMessages(null); }

    private void copyReport(WebView view, int id, String text) {
        if (text.length() > REPORT_LIMIT) throw new IllegalArgumentException();
        io.execute(() -> {
            boolean failed = false;
            try {
                String compact = new JSONObject(text).toString();
                ClipData clip = ClipData.newPlainText("WorkStep 运行诊断", compact);
                PersistableBundle extras = new PersistableBundle();
                extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                clip.getDescription().setExtras(extras);
                activity.getSystemService(ClipboardManager.class).setPrimaryClip(clip);
            } catch (Exception error) { failed = true; }
            boolean error = failed;
            activity.runOnUiThread(() -> reply(view, id, !error, error));
        });
    }

    private void save(WebView view, int id, String text) {
        if (pendingSave != null || text.length() > REPORT_LIMIT) throw new IllegalArgumentException();
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > REPORT_LIMIT) throw new IllegalArgumentException();
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json").putExtra(Intent.EXTRA_TITLE, "WorkStep-runtime-diagnostics.json");
        beforePicker.run();
        activity.startActivityForResult(intent, SAVE_REQUEST);
        pendingSave = new Save(view, id, bytes);
    }

    boolean activityResult(int request, int result, Intent data) {
        if (request != SAVE_REQUEST) return false;
        Save save = pendingSave;
        pendingSave = null;
        if (save == null) return true;
        Uri destination = data == null ? null : data.getData();
        if (result != Activity.RESULT_OK || destination == null) {
            reply(save.view, save.id, false, false);
            return true;
        }
        io.execute(() -> {
            boolean failed = false;
            try (OutputStream file = activity.getContentResolver().openOutputStream(destination, "wt")) {
                if (file == null) throw new IllegalStateException();
                file.write(save.bytes);
            } catch (Exception error) { failed = true; }
            boolean error = failed;
            activity.runOnUiThread(() -> reply(save.view, save.id, !error, error));
        });
        return true;
    }

    private void reply(WebView view, int request, Object result, boolean failed) {
        if (viewer != view) return;
        view.evaluateJavascript("window.resolveRuntimeDiagnostics(" + request + "," + result + "," + failed + ")", null);
    }
}
