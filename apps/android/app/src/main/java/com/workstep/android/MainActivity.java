package com.workstep.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.provider.DocumentsContract;
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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String SERVER_KEY = "server_origin";
    private static final String MENU_X_KEY = "connection_menu_x";
    private static final String MENU_Y_KEY = "connection_menu_y";
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
    private FrameLayout root;
    private WebView webView;
    private ServerAddress server;
    private ValueCallback<Uri[]> fileCallback;
    private PendingDownload pendingDownload;
    private boolean checking;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
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
        address.setHint("https://workstep.example.com");
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
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new WebViewClient() {
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
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
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
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(child);
                resultMsg.sendToTarget();
                return true;
            }
        });
        view.setDownloadListener(downloadListener);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        view.loadUrl(server.origin() + "/");
        addConnectionMenu();
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
            PopupMenu menu = new PopupMenu(this, button);
            menu.getMenu().add(R.string.change_address).setOnMenuItemClickListener(item -> {
                showAddressScreen(server.origin());
                return true;
            });
            menu.getMenu().add(R.string.reload).setOnMenuItemClickListener(item -> {
                if (webView != null) webView.reload();
                return true;
            });
            menu.show();
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
        button.setOnTouchListener(new View.OnTouchListener() {
            private float startRawX;
            private float startRawY;
            private float startX;
            private float startY;
            private boolean dragging;

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startRawX = event.getRawX();
                        startRawY = event.getRawY();
                        startX = view.getX();
                        startY = view.getY();
                        dragging = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - startRawX;
                        float dy = event.getRawY() - startRawY;
                        if (!dragging && Math.hypot(dx, dy) > touchSlop) dragging = true;
                        if (dragging) {
                            view.setX(clamp(startX + dx, root.getWidth() - view.getWidth()));
                            view.setY(clamp(startY + dy, root.getHeight() - view.getHeight()));
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (dragging) {
                            getPreferences(MODE_PRIVATE).edit()
                                    .putFloat(MENU_X_KEY, view.getX() / Math.max(1, root.getWidth()))
                                    .putFloat(MENU_Y_KEY, view.getY() / Math.max(1, root.getHeight()))
                                    .apply();
                        } else {
                            view.performClick();
                        }
                        return true;
                    case MotionEvent.ACTION_CANCEL:
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
            String type = mime == null ? "" : mime.split(";", 2)[0].trim();
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            save.addCategory(Intent.CATEGORY_OPENABLE);
            save.setType(type.isEmpty() ? "application/octet-stream" : type);
            save.putExtra(Intent.EXTRA_TITLE, filename);
            pendingDownload = new PendingDownload(server, url, userAgent);
            startActivityForResult(save, SAVE_REQUEST);
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
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        clearPage();
        executor.shutdownNow();
        super.onDestroy();
    }
}
