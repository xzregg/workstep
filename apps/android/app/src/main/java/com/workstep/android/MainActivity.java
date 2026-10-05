package com.workstep.android;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONArray;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String SERVER_KEY = "server_origin";
    private static final String PAGE_KEY = "last_page_url";
    private static final String MENU_X_KEY = "connection_menu_x";
    private static final String MENU_Y_KEY = "connection_menu_y";
    private static final String WATCH_SERVICE_REQUESTED_KEY = "watch_service_requested";
    private static final int FILE_REQUEST = 1001;
    private static final int SAVE_REQUEST = 1002;

    private static final class PendingDownload {
        final ServerAddress server;
        final String url;
        final String userAgent;

        PendingDownload(ServerAddress server, String url, String userAgent) {
            this.server = server;
            this.url = url;
            this.userAgent = userAgent;
        }
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ForegroundRefresh foregroundRefresh = new ForegroundRefresh();
    private FrameLayout root;
    private WebView webView;
    private ServerAddress server;
    private ValueCallback<Uri[]> fileCallback;
    private PendingDownload pendingDownload;
    private ApkInstaller apkInstaller;
    private boolean checking;
    private long lastRendererFailure;
    private static volatile boolean activityVisible;
    private final HashMap<String, JSONObject> completionWatches = new HashMap<>();

    static boolean isVisibleToUser() { return activityVisible; }

    private void startCompletionWatchService() {
        if (server == null || completionWatches.isEmpty()) return;
        try {
            CrashReports.log(this, "网页主进程", "切后台，启动监听；数量=" + completionWatches.size(), null);
            String watches = new JSONArray(completionWatches.values()).toString();
            Intent intent = new Intent(this, CompletionWatchService.class);
            intent.putExtra("server", server.origin());
            intent.putExtra("watches", watches);
            intent.putExtra("cookie", CookieManager.getInstance().getCookie(server.origin()));
            intent.putExtra("page", webView == null ? "" : webView.getUrl());
            getPreferences(MODE_PRIVATE).edit().putBoolean(WATCH_SERVICE_REQUESTED_KEY, true).apply();
            startForegroundService(intent);
        } catch (RuntimeException error) {
            getPreferences(MODE_PRIVATE).edit().putBoolean(WATCH_SERVICE_REQUESTED_KEY, false).apply();
            android.util.Log.e("WorkStep", "Cannot start completion watcher", error);
            CrashReports.log(this, "网页主进程", "启动监听失败", error);
        }
    }

    private void stopCompletionWatchService() {
        if (!getPreferences(MODE_PRIVATE).getBoolean(WATCH_SERVICE_REQUESTED_KEY, false)) return;
        Intent stop = new Intent(this, CompletionWatchService.class);
        stop.setAction(CompletionWatchService.ACTION_STOP);
        try {
            startForegroundService(stop);
            getPreferences(MODE_PRIVATE).edit().putBoolean(WATCH_SERVICE_REQUESTED_KEY, false).apply();
        } catch (RuntimeException error) {
            CrashReports.log(this, "网页主进程", "停止后台监听失败", error);
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        CrashReports.install(this, "网页主进程");
        CrashReports.log(this, "网页主进程", "应用启动；版本=1.0.25", null);
        root = new FrameLayout(this);
        apkInstaller = new ApkInstaller(this, executor, foregroundRefresh::externalPickerStarted);
        CompletionNotifications.createChannels(this);
        setContentView(root);
        String saved = getPreferences(MODE_PRIVATE).getString(SERVER_KEY, "");
        if (saved.isEmpty()) {
            showAddressScreen("");
        } else {
            try {
                server = ServerAddress.parse(saved);
                showWebView();
            } catch (IllegalArgumentException error) {
                showAddressScreen(saved);
            }
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void clearPage() {
        if (webView != null) rememberPage(webView.getUrl());
        root.removeAllViews();
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
    }

    private void showAddressScreen(String current) {
        clearPage();
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(24), dp(40), dp(24), dp(24));
        root.addView(page, new FrameLayout.LayoutParams(-1, -1));

        TextView title = new TextView(this);
        title.setText(R.string.connect_title);
        title.setTextSize(23);
        page.addView(title);

        TextView help = new TextView(this);
        help.setText(R.string.connect_help);
        help.setTextSize(14);
        LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(-1, -2);
        helpParams.topMargin = dp(14);
        page.addView(help, helpParams);

        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("http://192.168.1.10:8765 或 https://workstep.example.com");
        address.setText(current);
        address.setContentDescription(getString(R.string.server_url));
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(-1, -2);
        addressParams.topMargin = dp(20);
        page.addView(address, addressParams);

        Button connect = new Button(this);
        connect.setText(R.string.connect);
        page.addView(connect);

        ProgressBar progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(36), dp(36));
        progressParams.gravity = Gravity.CENTER_HORIZONTAL;
        page.addView(progress, progressParams);

        TextView error = new TextView(this);
        error.setTextColor(0xFFB3261E);
        page.addView(error);

        connect.setOnClickListener(view -> {
            if (checking) return;
            ServerAddress candidate;
            try {
                candidate = ServerAddress.parse(address.getText().toString());
            } catch (IllegalArgumentException reason) {
                error.setText(reason.getMessage());
                return;
            }
            checking = true;
            connect.setEnabled(false);
            progress.setVisibility(View.VISIBLE);
            error.setText("");
            executor.execute(() -> {
                String failure = checkServer(candidate);
                runOnUiThread(() -> {
                    checking = false;
                    if (isFinishing() || isDestroyed()) return;
                    connect.setEnabled(true);
                    progress.setVisibility(View.GONE);
                    if (failure != null) {
                        error.setText(failure);
                        return;
                    }
                    if (server == null || !server.origin().equals(candidate.origin())) {
                        completionWatches.clear();
                        stopCompletionWatchService();
                    }
                    server = candidate;
                    getPreferences(MODE_PRIVATE).edit().putString(SERVER_KEY, candidate.origin()).apply();
                    showWebView();
                });
            });
        });
    }

    private String checkServer(ServerAddress candidate) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(candidate.origin() + "/api/health").openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(false);
            if (connection.getResponseCode() != 200) return "服务器未返回 WorkStep 健康检查";
            try (InputStream stream = connection.getInputStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[1024];
                int length;
                while (output.size() < 4096 && (length = stream.read(buffer, 0,
                        Math.min(buffer.length, 4096 - output.size()))) != -1) {
                    output.write(buffer, 0, length);
                }
                byte[] body = output.toByteArray();
                length = body.length;
                if (length <= 0 || !"ok".equals(new JSONObject(
                        new String(body, 0, length, StandardCharsets.UTF_8)).optString("status"))) {
                    return "该地址不是可用的 WorkStep 服务";
                }
            }
            return null;
        } catch (Exception error) {
            return "无法连接：" + error.getLocalizedMessage();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // The existing React application requires JavaScript.
    private void showWebView() {
        clearPage();
        WebView view = new WebView(this);
        webView = view;
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSafeBrowsingEnabled(true);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, "WorkStepAndroid",
                    Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                        if (!isMainFrame || server == null || !server.contains(sourceOrigin.toString())) return;
                        handleNotificationMessage(message.getData());
                    });
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void doUpdateVisitedHistory(WebView source, String url, boolean isReload) {
                if (source == webView) rememberPage(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (server.contains(url)) return false;
                openExternal(url);
                return true;
            }

            @Override
            public void onReceivedError(WebView source, WebResourceRequest request, WebResourceError error) {
                if (source == webView && request.isForMainFrame())
                    showWebError("网页加载失败：" + error.getDescription());
            }

            @Override
            public void onReceivedSslError(WebView source, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (source == webView) showWebError("HTTPS 证书验证失败");
            }

            @Override
            public boolean onRenderProcessGone(WebView source, RenderProcessGoneDetail detail) {
                if (source != webView) return true;
                android.util.Log.e("WorkStep", "WebView renderer exited; crashed=" + detail.didCrash());
                CrashReports.log(MainActivity.this, "网页主进程", "网页进程退出；crashed=" + detail.didCrash(), null);
                long now = SystemClock.elapsedRealtime();
                boolean repeated = now - lastRendererFailure < 10000;
                lastRendererFailure = now;
                root.removeAllViews();
                source.destroy();
                webView = null;
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                }
                if (repeated) showAddressScreen(server.origin());
                else showWebView();
                Toast.makeText(MainActivity.this, "网页进程已恢复，请重试刚才的操作", Toast.LENGTH_LONG).show();
                return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent picker = createFileChooserIntent(params);
                    startActivityForResult(picker, FILE_REQUEST);
                    foregroundRefresh.externalPickerStarted();
                    return true;
                } catch (Exception error) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return true;
                }
            }

            @Override
            public boolean onCreateWindow(WebView source, boolean isDialog, boolean isUserGesture,
                    Message resultMsg) {
                if (!isUserGesture) return false;
                WebView child = new WebView(MainActivity.this);
                final boolean[] handled = {false};
                child.setWebViewClient(new WebViewClient() {
                    private void handle(String url) {
                        if (handled[0] || "about:blank".equals(url)) return;
                        handled[0] = true;
                        openNewWindowUrl(url);
                        child.post(child::destroy);
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                        handle(request.getUrl().toString());
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView ignored, String url, android.graphics.Bitmap icon) {
                        handle(url);
                    }

                    @Override
                    public boolean onRenderProcessGone(WebView popup, RenderProcessGoneDetail detail) {
                        CrashReports.log(MainActivity.this, "网页主进程",
                                "弹出网页进程退出；crashed=" + detail.didCrash(), null);
                        popup.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(child);
                resultMsg.sendToTarget();
                return true;
            }
        });
        view.setDownloadListener(downloadListener);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        String requestedPage = notificationPage(getIntent());
        if (requestedPage != null) clearNotificationPage(getIntent());
        view.loadUrl(server.pageOrRoot(requestedPage != null ? requestedPage
                : getPreferences(MODE_PRIVATE).getString(PAGE_KEY, "")));
        addConnectionMenu();
        view.post(this::requestNotificationPermissionIfNeeded);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33 || isFinishing() || isDestroyed()
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
                || getPreferences(MODE_PRIVATE).getBoolean("notification_permission_asked", false)) return;
        getPreferences(MODE_PRIVATE).edit().putBoolean("notification_permission_asked", true).apply();
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1003);
        } catch (RuntimeException error) {
            android.util.Log.e("WorkStep", "Cannot request notification permission", error);
        }
    }

    private void rememberPage(String url) {
        if (server != null && url != null && server.contains(url))
            getPreferences(MODE_PRIVATE).edit().putString(PAGE_KEY, url).apply();
    }

    private void handleNotificationMessage(String raw) {
        try {
            JSONObject message = new JSONObject(raw);
            String type = message.optString("type");
            if ("project".equals(type)) {
                String projectId = message.optString("projectId");
                completionWatches.entrySet().removeIf(entry ->
                        !projectId.equals(entry.getValue().optString("projectId")));
                return;
            }
            String id = message.optString("id");
            if (id.isEmpty()) return;
            if ("watch".equals(type)) {
                if (!message.optString("projectId").isEmpty()
                        && (!message.optString("sessionId").isEmpty() || !message.optString("taskId").isEmpty())) {
                    completionWatches.put(id, message);
                    CrashReports.log(this, "网页主进程", "登记监听；数量=" + completionWatches.size(), null);
                }
            } else if ("unwatch".equals(type)) {
                completionWatches.remove(id);
                CrashReports.log(this, "网页主进程", "取消监听；数量=" + completionWatches.size(), null);
            } else if ("notify".equals(type)) {
                String target = message.optString("url");
                if (activityVisible && webView != null
                        && !NotificationView.shouldNotify(webView.getUrl(), target, server)) {
                    CrashReports.log(this, "网页主进程", "结果属于当前详情，未弹系统通知", null);
                    return;
                }
                String outcome = message.optString("outcome");
                if (!"succeeded".equals(outcome) && !"failed".equals(outcome)) return;
                boolean success = "succeeded".equals(outcome);
                boolean task = !message.optString("taskId").isEmpty();
                boolean step = !message.optString("stepKey").isEmpty();
                boolean shown = CompletionNotifications.show(this, id,
                        step ? (success ? "WorkStep 步骤完成" : "WorkStep 步骤失败")
                                : (success ? "WorkStep 回复完成" : "WorkStep 回复失败"),
                        step ? "步骤 " + message.optString("stepKey") + (success ? " 已通过" : " 执行失败")
                                : (task ? "任务" : "会话") + "的回复" + (success ? "已完成" : "失败"),
                        target, server);
                CrashReports.log(this, "网页主进程",
                        shown ? "网页桥接已发送系统通知" : "网页桥接通知未显示：权限、系统设置或重复", null);
            }
        } catch (Exception error) {
            android.util.Log.e("WorkStep", "Notification bridge message failed", error);
            CrashReports.log(this, "网页主进程", "通知桥接失败", error);
        }
    }

    private Intent createFileChooserIntent(WebChromeClient.FileChooserParams params) {
        boolean imageOnly = FileChooserMode.isImageOnly(params.getAcceptTypes());
        boolean multiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        if (imageOnly && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES);
            picker.setType("image/*");
            if (multiple) {
                picker.putExtra(
                        MediaStore.EXTRA_PICK_IMAGES_MAX,
                        Math.min(20, MediaStore.getPickImagesMaxLimit())
                );
            }
            return picker;
        }
        if (imageOnly) {
            Intent picker = new Intent(Intent.ACTION_PICK);
            picker.setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image/*");
            picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
            return picker;
        }

        Intent picker = params.createIntent();
        return picker;
    }

    private Uri[] selectedFiles(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) return null;
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            ArrayList<Uri> uris = new ArrayList<>();
            for (int index = 0; index < clip.getItemCount(); index += 1) {
                Uri uri = clip.getItemAt(index).getUri();
                if (uri != null) uris.add(uri);
            }
            return uris.isEmpty() ? null : uris.toArray(new Uri[0]);
        }
        if (data.getData() != null) return new Uri[] {data.getData()};
        return WebChromeClient.FileChooserParams.parseResult(resultCode, data);
    }

    @SuppressLint("ClickableViewAccessibility") // Tap path calls performClick; dragging consumes moves.
    private void addConnectionMenu() {
        ImageButton button = new ImageButton(this);
        button.setImageResource(R.drawable.connection_menu_icon);
        button.setBackgroundResource(R.drawable.connection_menu_background);
        button.setPadding(0, 0, 0, 0);
        button.setContentDescription(getString(R.string.connection_options));
        button.setElevation(dp(4));
        FrameLayout.LayoutParams position = new FrameLayout.LayoutParams(dp(44), dp(44),
                Gravity.TOP | Gravity.START);
        root.addView(button, position);
        button.setOnClickListener(view -> {
            if (webView != null) webView.evaluateJavascript(
                    "(function(){var open=document.querySelector('button[aria-controls=\"workstep-navigation\"]');"
                            + "var nav=document.getElementById('workstep-navigation');"
                            + "var close=nav&&nav.querySelector('button.navigation-close');"
                            + "if(open&&open.getAttribute('aria-expanded')==='true'){if(close)close.click()}"
                            + "else if(open)open.click()})()",
                    null);
        });
        button.setOnLongClickListener(view -> {
            PopupMenu menu = new PopupMenu(this, view);
            menu.getMenu().add(R.string.change_address).setOnMenuItemClickListener(item -> {
                showAddressScreen(server.origin());
                return true;
            });
            menu.getMenu().add(R.string.reload).setOnMenuItemClickListener(item -> {
                if (webView != null) webView.reload();
                return true;
            });
            menu.getMenu().add(R.string.clear_web_cache).setOnMenuItemClickListener(item -> {
                if (webView != null) {
                    webView.clearCache(true);
                    webView.reload();
                    Toast.makeText(this, R.string.web_cache_cleared, Toast.LENGTH_SHORT).show();
                }
                return true;
            });
            menu.getMenu().add(R.string.view_logs).setOnMenuItemClickListener(item -> {
                CrashReports.showLogs(this);
                return true;
            });
            menu.getMenu().add(R.string.test_notification).setOnMenuItemClickListener(item -> {
                boolean shown = CompletionNotifications.show(this,
                        "test-" + SystemClock.elapsedRealtime(), "WorkStep 测试通知",
                        "如果能看到这条通知，系统通知权限正常", "/", server);
                CrashReports.log(this, "网页主进程", shown ? "测试通知已发送" : "测试通知未显示：权限或系统设置", null);
                Toast.makeText(this, shown ? "已发送测试通知" : "系统未允许显示通知", Toast.LENGTH_SHORT).show();
                return true;
            });
            menu.show();
            return true;
        });
        root.post(() -> {
            if (button.getParent() != root) return;
            int width = root.getWidth();
            int height = root.getHeight();
            float savedX = getPreferences(MODE_PRIVATE).getFloat(MENU_X_KEY, -1f);
            float savedY = getPreferences(MODE_PRIVATE).getFloat(MENU_Y_KEY, -1f);
            float x = savedX < 0 ? width / 2f + dp(40) : savedX * width;
            float y = savedY < 0 ? dp(6) : savedY * height;
            button.setX(clamp(x, width - button.getWidth()));
            button.setY(clamp(y, height - button.getHeight()));
        });
        int touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
        FloatingButtonGesture gesture = new FloatingButtonGesture();
        Runnable longPress = () -> {
            if (button.getParent() == root && gesture.longPress()) button.performLongClick();
        };
        button.setOnTouchListener(new View.OnTouchListener() {
            private float startRawX;
            private float startRawY;
            private float startX;
            private float startY;
            @Override
            public boolean onTouch(View view, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startRawX = event.getRawX();
                        startRawY = event.getRawY();
                        startX = view.getX();
                        startY = view.getY();
                        gesture.down();
                        view.postDelayed(longPress, ViewConfiguration.getLongPressTimeout());
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - startRawX;
                        float dy = event.getRawY() - startRawY;
                        if (gesture.move(dx, dy, touchSlop)) {
                            view.removeCallbacks(longPress);
                            view.setX(clamp(startX + dx, root.getWidth() - view.getWidth()));
                            view.setY(clamp(startY + dy, root.getHeight() - view.getHeight()));
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        view.removeCallbacks(longPress);
                        FloatingButtonGesture.Release release = gesture.release();
                        if (release == FloatingButtonGesture.Release.DRAG) {
                            getPreferences(MODE_PRIVATE).edit()
                                    .putFloat(MENU_X_KEY, view.getX() / Math.max(1, root.getWidth()))
                                    .putFloat(MENU_Y_KEY, view.getY() / Math.max(1, root.getHeight()))
                                    .apply();
                        } else if (release == FloatingButtonGesture.Release.TAP) {
                            view.performClick();
                        }
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        view.removeCallbacks(longPress);
                        gesture.cancel();
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private float clamp(float coordinate, int maximum) {
        return Math.max(0, Math.min(coordinate, Math.max(0, maximum)));
    }

    private void openNewWindowUrl(String url) {
        if (server.contains(url) && webView != null) webView.loadUrl(url);
        else openExternal(url);
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                && !"mailto".equalsIgnoreCase(scheme) && !"tel".equalsIgnoreCase(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(this, "无法打开外部链接", Toast.LENGTH_SHORT).show();
        }
    }

    private final DownloadListener downloadListener = (url, userAgent, disposition, mime, length) -> {
        if (server == null || !server.contains(url)) {
            Toast.makeText(this, "只能下载当前服务的文件", Toast.LENGTH_SHORT).show();
            return;
        }
        if (pendingDownload != null) {
            Toast.makeText(this, "请先完成当前文件的保存选择", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            String filename = URLUtil.guessFileName(url, disposition, mime)
                    .replaceAll("[/\\\\]", "_");
            if (ApkDownloadPolicy.isApk(filename, mime)) {
                apkInstaller.download(server, url, userAgent, filename);
                return;
            }
            String type = mime == null ? "" : mime.split(";", 2)[0].trim();
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            save.addCategory(Intent.CATEGORY_OPENABLE);
            save.setType(type.isEmpty() ? "application/octet-stream" : type);
            save.putExtra(Intent.EXTRA_TITLE, filename);
            pendingDownload = new PendingDownload(server, url, userAgent);
            startActivityForResult(save, SAVE_REQUEST);
            foregroundRefresh.externalPickerStarted();
        } catch (Exception error) {
            pendingDownload = null;
            Toast.makeText(this, "无法打开保存位置选择器", Toast.LENGTH_LONG).show();
        }
    };

    private String saveDownload(PendingDownload download, String cookie, Uri document) {
        String address = download.url;
        try {
            for (int redirects = 0; redirects <= 5; redirects++) {
                HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
                try {
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(30000);
                    connection.setInstanceFollowRedirects(false);
                    if (download.userAgent != null && !download.userAgent.isEmpty())
                        connection.setRequestProperty("User-Agent", download.userAgent);
                    if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
                    int status = connection.getResponseCode();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        String location = connection.getHeaderField("Location");
                        if (location == null) throw new IllegalStateException("服务器未提供下载地址");
                        address = download.server.resolveSameOrigin(address, location);
                        continue;
                    }
                    if (status != 200) throw new IllegalStateException("服务器返回 HTTP " + status);
                    try (InputStream input = connection.getInputStream();
                         OutputStream output = getContentResolver().openOutputStream(document, "w")) {
                        if (output == null) throw new IllegalStateException("无法写入所选位置");
                        byte[] buffer = new byte[16384];
                        int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    }
                    return null;
                } finally {
                    connection.disconnect();
                }
            }
            throw new IllegalStateException("下载重定向次数过多");
        } catch (Exception error) {
            try {
                DocumentsContract.deleteDocument(getContentResolver(), document);
            } catch (Exception ignored) {
                // Some document providers cannot delete a failed partial file.
            }
            return error.getLocalizedMessage();
        }
    }

    private void showWebError(String message) {
        if (root.findViewWithTag("connection_error") != null) return;
        LinearLayout panel = new LinearLayout(this);
        panel.setTag("connection_error");
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(24), dp(24), dp(24), dp(24));
        panel.setBackgroundColor(0xFFFFFFFF);
        TextView text = new TextView(this);
        text.setText(message);
        text.setGravity(Gravity.CENTER);
        panel.addView(text);
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(view -> {
            root.removeView(panel);
            if (webView != null) webView.reload();
        });
        panel.addView(retry);
        Button change = new Button(this);
        change.setText(R.string.change_address);
        change.setOnClickListener(view -> showAddressScreen(server.origin()));
        panel.addView(change);
        root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (apkInstaller.onActivityResult(requestCode)) return;
        if (requestCode == SAVE_REQUEST) {
            PendingDownload download = pendingDownload;
            pendingDownload = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && download != null) {
                Uri document = data.getData();
                String cookie = CookieManager.getInstance().getCookie(download.url);
                Toast.makeText(this, "正在保存文件", Toast.LENGTH_SHORT).show();
                executor.execute(() -> {
                    String failure = saveDownload(download, cookie, document);
                    runOnUiThread(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        Toast.makeText(this, failure == null ? "文件已保存" : "保存失败：" + failure,
                                Toast.LENGTH_LONG).show();
                    });
                });
            }
            return;
        }
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(selectedFiles(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    protected void onPause() {
        CrashReports.log(this, "网页主进程", "进入后台；监听数量=" + completionWatches.size(), null);
        startCompletionWatchService();
        activityVisible = false;
        super.onPause();
    }

    @Override
    protected void onStop() {
        CrashReports.log(this, "网页主进程", "页面停止；监听数量=" + completionWatches.size(), null);
        if (webView != null) rememberPage(webView.getUrl());
        foregroundRefresh.onStop(SystemClock.elapsedRealtime());
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityVisible = true;
        CrashReports.log(this, "网页主进程", "返回前台；监听数量=" + completionWatches.size(), null);
        stopCompletionWatchService();
        CrashReports.showIfPresent(this);
        boolean reload = foregroundRefresh.onResume(SystemClock.elapsedRealtime());
        if (webView != null) {
            if (reload) webView.reload();
            else webView.evaluateJavascript("window.dispatchEvent(new Event('workstep:resume'))", null);
        }
        openNotificationPage(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (activityVisible) openNotificationPage(intent);
    }

    private String notificationPage(Intent intent) {
        if (intent == null || server == null) return null;
        String page = intent.getStringExtra("notification_page");
        if (page == null && intent.getData() != null) page = intent.getDataString();
        return page != null && server.contains(page) ? page : null;
    }

    private void clearNotificationPage(Intent intent) {
        intent.removeExtra("notification_page");
        intent.setData(null);
    }

    private void openNotificationPage(Intent intent) {
        String page = notificationPage(intent);
        if (page == null || webView == null) return;
        clearNotificationPage(intent);
        CrashReports.log(this, "网页主进程", "点击通知，打开对应页面", null);
        webView.loadUrl(page);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        CrashReports.log(this, "网页主进程", "页面销毁；监听数量=" + completionWatches.size(), null);
        activityVisible = false;
        clearPage();
        apkInstaller.dispose();
        executor.shutdownNow();
        super.onDestroy();
    }
}
