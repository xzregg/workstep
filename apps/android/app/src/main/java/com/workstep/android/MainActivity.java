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
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
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
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
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
    private static final String SERVER_LIST_KEY = "server_origins";
    private static final String P2P_ACTIVE_KEY = "p2p_active_url";
    private static final String P2P_PAGE_PREFIX = "p2p_last_page:";
    private static final String PAGE_KEY = "last_page_url";
    private static final String MENU_X_KEY = "connection_menu_x";
    private static final String MENU_Y_KEY = "connection_menu_y";
    private static final String WATCH_SERVICE_REQUESTED_KEY = "watch_service_requested";
    private static final String KEEP_SCREEN_ON_KEY = "keep_screen_on";
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
    private P2pDownload p2pDownload;
    private final GatewayLoginNavigation gatewayLoginNavigation = new GatewayLoginNavigation();
    private FrameLayout root;
    private WebView webView;
    private ServerAddress server;
    private P2pStore p2pStore;
    private P2pConnection activeP2p;
    private ImageCapture imageCapture;
    private ValueCallback<Uri[]> fileCallback;
    private PendingDownload pendingDownload;
    private ApkInstaller apkInstaller;
    private MicrophonePermissions microphonePermissions;
    private boolean checking;
    private boolean pageLoading;
    private boolean pageHadError;
    private SystemSpeech systemSpeech;
    private CalendarHost calendarHost;
    private int pageLoadGeneration;
    private long lastRendererFailure;
    private static volatile boolean activityVisible;
    private final HashMap<String, JSONObject> completionWatches = new HashMap<>();
    private String notificationProjectId = "";
    private String notificationProjectName = "";
    private int notificationNavigationGeneration;
    private RuntimeDiagnostics runtimeDiagnostics;

    static boolean isVisibleToUser() { return activityVisible; }

    String diagnosticPage() {
        String url = webView == null ? null : webView.getUrl();
        if (url == null) return "未打开网页";
        Uri page = Uri.parse(url);
        if (!page.isHierarchical()) return page.getScheme() + "；加载中=" + pageLoading + "；加载错误=" + pageHadError;
        Uri.Builder safe = new Uri.Builder().scheme(page.getScheme())
                .encodedAuthority(page.getEncodedAuthority()).path(page.getPath());
        for (String key : new String[]{"project", "workflow", "task", "session"}) {
            String value = page.getQueryParameter(key);
            if (value != null) safe.appendQueryParameter(key, value);
        }
        return safe.build() + "；加载中=" + pageLoading + "；加载错误=" + pageHadError;
    }

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
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags
                & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        runtimeDiagnostics = new RuntimeDiagnostics(this,
                () -> canCapturePerformance() ? webView : null,
                () -> server == null ? "" : server.origin(), foregroundRefresh::externalPickerStarted);
        CrashReports.install(this, "网页主进程");
        CrashReports.log(this, "网页主进程", "应用启动；" + CrashReports.version(this), null);
        root = new FrameLayout(this);
        apkInstaller = new ApkInstaller(this, executor, foregroundRefresh::externalPickerStarted);
        p2pDownload = new P2pDownload(this, foregroundRefresh::externalPickerStarted, apkInstaller);
        microphonePermissions = new MicrophonePermissions(this, () -> webView, () -> server);
        CompletionNotifications.createChannels(this);
        setContentView(root);
        p2pStore = new P2pStore(this);
        String savedP2p = getPreferences(MODE_PRIVATE).getString(P2P_ACTIVE_KEY, "");
        for (P2pConnection item : p2pStore.load()) {
            if (item.entryUrl().equals(savedP2p)) { activeP2p = item; break; }
        }
        if (activeP2p != null) {
            server = activeP2p.server();
            showWebView();
            return;
        }
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

    private void stylePrimary(Button button) {
        button.setAllCaps(false);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(0xFF0B68D0));
        button.setTextColor(0xFFFFFFFF);
        button.setMinHeight(dp(48));
    }

    private void updateKeepScreenOn() {
        if (activityVisible && getPreferences(MODE_PRIVATE).getBoolean(KEEP_SCREEN_ON_KEY, true))
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void clearPage() {
        p2pDownload.cancel();
        runtimeDiagnostics.navigation();
        if (systemSpeech != null) { systemSpeech.close(); systemSpeech = null; }
        if (imageCapture != null) imageCapture.clear();
        if (microphonePermissions != null) microphonePermissions.clear();
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

    private boolean setupP2pTab = true;

    private android.graphics.drawable.GradientDrawable rounded(int color, int stroke, int radius) {
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        if (stroke != 0) shape.setStroke(dp(1), stroke);
        return shape;
    }

    private TextView label(String value, int size, int color, boolean bold) {
        TextView text = new TextView(this);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(color);
        if (bold) text.setTypeface(null, android.graphics.Typeface.BOLD);
        return text;
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private void addGap(LinearLayout parent, int height) {
        parent.addView(new View(this), new LinearLayout.LayoutParams(1, dp(height)));
    }

    private Button setupButton(String title, boolean primary) {
        Button button = new Button(this);
        button.setText(title);
        button.setAllCaps(false);
        button.setTextSize(13);
        button.setTypeface(null, android.graphics.Typeface.BOLD);
        button.setTextColor(primary ? 0xFFFFFFFF : 0xFF1265C4);
        button.setBackground(rounded(primary ? 0xFF0B68D0 : 0xFFFFFFFF,
                primary ? 0 : 0xFFCAD5E1, 9));
        button.setMinHeight(dp(48));
        button.setMinimumHeight(dp(48));
        return button;
    }

    private EditText setupInput(String hint) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setTextSize(12);
        input.setTextColor(0xFF20242B);
        input.setHintTextColor(0xFF8794A4);
        input.setHint(hint);
        input.setPadding(dp(11), 0, dp(11), 0);
        input.setBackground(rounded(0xFFFFFFFF, 0xFFD4DCE7, 9));
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        return input;
    }

    private void sectionTitle(LinearLayout panel, String title, String count) {
        LinearLayout line = new LinearLayout(this);
        line.setGravity(Gravity.CENTER_VERTICAL);
        line.addView(label(title, 14, 0xFF20242B, true), new LinearLayout.LayoutParams(0, -2, 1));
        if (count != null) line.addView(label(count, 11, 0xFF8290A0, false));
        panel.addView(line);
        addGap(panel, 9);
    }

    private LinearLayout card(LinearLayout parent, int padding) {
        LinearLayout card = vertical();
        card.setPadding(dp(padding), dp(padding), dp(padding), dp(padding));
        card.setBackground(rounded(0xFFFFFFFF, 0xFFE2E8F0, 14));
        parent.addView(card, new LinearLayout.LayoutParams(-1, -2));
        return card;
    }

    private void showAddressScreen(String current) {
        clearPage();
        LinearLayout screen = vertical();
        screen.setBackgroundColor(0xFFF8FAFC);
        root.addView(screen, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(8), 0, dp(8), 0);
        bar.setBackgroundColor(0xFFFFFFFF);
        Button back = new Button(this);
        back.setText("‹");
        back.setTextSize(30);
        back.setTextColor(0xFF1671D6);
        back.setBackgroundColor(0xFFFFFFFF);
        back.setOnClickListener(v -> { if (server != null) showWebView(); else finish(); });
        bar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(56)));
        TextView title = label("连接 WorkStep", 17, 0xFF20242B, true);
        title.setGravity(Gravity.CENTER);
        bar.addView(title, new LinearLayout.LayoutParams(0, dp(56), 1));
        bar.addView(new View(this), new LinearLayout.LayoutParams(dp(48), dp(56)));
        screen.addView(bar);
        View divider = new View(this); divider.setBackgroundColor(0xFFE9EDF2);
        screen.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        screen.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout page = vertical();
        page.setPadding(dp(18), dp(20), dp(18), dp(40));
        scroll.addView(page);

        LinearLayout activeCard = vertical();
        activeCard.setPadding(dp(16), dp(15), dp(16), dp(16));
        activeCard.setBackground(rounded(0xFF0D61BB, 0, 15));
        String activeType = activeP2p != null ? "P2P 设备" : "网关地址";
        String activeName = activeP2p != null ? activeP2p.name()
                : server == null ? "尚未连接" : server.origin();
        String activeUrl = activeP2p != null ? activeP2p.entryUrl()
                : server == null ? "请选择一个连接" : server.origin();
        activeCard.addView(label("当前连接 · " + activeType, 11, 0xFFD3E7FF, false));
        addGap(activeCard, 6);
        TextView name = label(activeName, 16, 0xFFFFFFFF, true);
        name.setSingleLine(true); name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        activeCard.addView(name);
        addGap(activeCard, 5);
        TextView url = label(activeUrl, 11, 0xFFD3E7FF, false);
        url.setSingleLine(true); url.setEllipsize(android.text.TextUtils.TruncateAt.END);
        activeCard.addView(url);
        page.addView(activeCard);
        addGap(page, 18);

        LinearLayout tabs = new LinearLayout(this);
        tabs.setPadding(dp(4), dp(4), dp(4), dp(4));
        tabs.setBackground(rounded(0xFFE7EDF5, 0, 12));
        Button gatewayTab = setupButton("网关地址", false);
        Button p2pTab = setupButton("P2P 设备", false);
        tabs.addView(gatewayTab, new LinearLayout.LayoutParams(0, dp(40), 1));
        LinearLayout.LayoutParams tabParams = new LinearLayout.LayoutParams(0, dp(40), 1);
        tabParams.leftMargin = dp(4);
        tabs.addView(p2pTab, tabParams);
        page.addView(tabs);
        addGap(page, 18);
        LinearLayout gatewayPanel = vertical();
        LinearLayout p2pPanel = vertical();
        page.addView(gatewayPanel);
        page.addView(p2pPanel);
        Runnable updateTabs = () -> {
            gatewayPanel.setVisibility(setupP2pTab ? View.GONE : View.VISIBLE);
            p2pPanel.setVisibility(setupP2pTab ? View.VISIBLE : View.GONE);
            gatewayTab.setBackground(rounded(setupP2pTab ? 0xFFE7EDF5 : 0xFFFFFFFF, 0, 9));
            p2pTab.setBackground(rounded(setupP2pTab ? 0xFFFFFFFF : 0xFFE7EDF5, 0, 9));
            gatewayTab.setTextColor(setupP2pTab ? 0xFF506279 : 0xFF0759B9);
            p2pTab.setTextColor(setupP2pTab ? 0xFF0759B9 : 0xFF506279);
        };
        gatewayTab.setOnClickListener(v -> { setupP2pTab = false; updateTabs.run(); });
        p2pTab.setOnClickListener(v -> { setupP2pTab = true; updateTabs.run(); });
        updateTabs.run();
        buildP2pPanel(p2pPanel);
        buildGatewayPanel(gatewayPanel, current, screen);
        addGap(page, 8);
        Button diagnostics = setupButton(getString(R.string.runtime_diagnostics), false);
        diagnostics.setOnClickListener(v -> runtimeDiagnostics.open());
        page.addView(diagnostics, new LinearLayout.LayoutParams(-1, dp(48)));
    }

    private void buildP2pPanel(LinearLayout panel) {
        sectionTitle(panel, "添加 P2P 设备", null);
        LinearLayout inputCard = card(panel, 13);
        LinearLayout scan = new LinearLayout(this);
        scan.setGravity(Gravity.CENTER_VERTICAL);
        scan.setPadding(dp(12), dp(8), dp(12), dp(8));
        scan.setBackground(rounded(0xFFEEF6FF, 0xFFC9DEF8, 12));
        TextView icon = label("⌗", 19, 0xFF0858AD, true);
        icon.setGravity(Gravity.CENTER);
        icon.setBackground(rounded(0xFFEEF6FF, 0xFF0858AD, 8));
        scan.addView(icon, new LinearLayout.LayoutParams(dp(32), dp(32)));
        LinearLayout scanText = vertical(); scanText.setPadding(dp(10), 0, 0, 0);
        scanText.addView(label("扫码添加设备", 13, 0xFF0858AD, true));
        scanText.addView(label("扫描电脑上的 WorkStep 配对码", 11, 0xFF527BA5, false));
        scan.addView(scanText);
        scan.setOnClickListener(v -> startActivityForResult(new Intent(this, P2pScanActivity.class), P2pScanActivity.REQUEST));
        inputCard.addView(scan, new LinearLayout.LayoutParams(-1, dp(56)));
        addGap(inputCard, 10);
        LinearLayout field = new LinearLayout(this);
        EditText link = setupInput("或粘贴 P2P 配对链接");
        field.addView(link, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button save = setupButton("保存", false);
        LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(dp(64), dp(48));
        saveParams.leftMargin = dp(8);
        field.addView(save, saveParams);
        inputCard.addView(field);
        save.setOnClickListener(v -> saveP2p(link.getText().toString(), false));
        addGap(panel, 17);
        java.util.List<P2pConnection> saved = p2pStore.load();
        sectionTitle(panel, "已保存的设备", saved.size() + " 条");
        LinearLayout list = card(panel, 0);
        final P2pConnection[] selected = {null};
        for (P2pConnection item : saved) {
            LinearLayout row = connectionRow(item.name(), item.entryUrl(),
                    activeP2p != null && activeP2p.entryUrl().equals(item.entryUrl()),
                    selected[0] == null, list);
            if (selected[0] == null) selected[0] = item;
            TextView dot = (TextView) row.getChildAt(0);
            row.setOnClickListener(v -> {
                selected[0] = item;
                selectRows(list, row);
            });
            dot.setOnClickListener(v -> { selected[0] = item; selectRows(list, row); });
            TextView remove = label("×", 18, 0xFF8D98A7, false);
            remove.setGravity(Gravity.CENTER);
            remove.setContentDescription("删除 " + item.name());
            row.addView(remove, new LinearLayout.LayoutParams(dp(44), dp(48)));
            remove.setOnClickListener(v -> {
                java.util.List<P2pConnection> remaining = p2pStore.load();
                remaining.removeIf(entry -> entry.entryUrl().equals(item.entryUrl()));
                try { p2pStore.save(remaining); }
                catch (IllegalStateException error) { Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); return; }
                getPreferences(MODE_PRIVATE).edit().remove(P2P_PAGE_PREFIX + item.entryUrl()).apply();
                if (activeP2p != null && activeP2p.entryUrl().equals(item.entryUrl())) {
                    activeP2p = null; server = null;
                    getPreferences(MODE_PRIVATE).edit().remove(P2P_ACTIVE_KEY).remove(SERVER_KEY).apply();
                }
                showAddressScreen("");
            });
        }
        if (saved.isEmpty()) {
            TextView empty = label("还没有保存的设备", 12, 0xFF8794A4, false);
            empty.setGravity(Gravity.CENTER);
            list.addView(empty, new LinearLayout.LayoutParams(-1, dp(58)));
        }
        Button switchP2p = setupButton("切换到所选连接", true);
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, dp(48));
        actionParams.setMargins(dp(12), dp(8), dp(12), dp(12));
        list.addView(switchP2p, actionParams);
        switchP2p.setEnabled(!saved.isEmpty());
        switchP2p.setOnClickListener(v -> { if (selected[0] != null) connectP2p(selected[0]); });
    }

    private LinearLayout connectionRow(String name, String url, boolean active,
                                       boolean selected, LinearLayout list) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(6), dp(6), dp(6));
        row.setBackgroundColor(selected ? 0xFFF4F9FF : 0xFFFFFFFF);
        TextView dot = label(selected ? "◉" : "○", 20,
                selected ? 0xFF0B6BD2 : 0xFF98A5B4, false);
        dot.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(dot, new LinearLayout.LayoutParams(dp(27), dp(48)));
        LinearLayout copy = vertical();
        TextView line1 = label(name, 12, 0xFF20242B, true);
        line1.setSingleLine(true); line1.setEllipsize(android.text.TextUtils.TruncateAt.END);
        TextView line2 = label(url, 10, 0xFF7C8998, false);
        line2.setSingleLine(true); line2.setEllipsize(android.text.TextUtils.TruncateAt.END);
        copy.addView(line1); copy.addView(line2);
        row.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        if (active) {
            TextView status = label("使用中", 10, 0xFF1469C7, true);
            status.setSingleLine(true);
            status.setPadding(dp(6), 0, 0, 0);
            row.addView(status);
        }
        list.addView(row, new LinearLayout.LayoutParams(-1, dp(60)));
        View divider = new View(this); divider.setBackgroundColor(0xFFEEF1F5);
        list.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
        return row;
    }

    private void selectRows(LinearLayout list, LinearLayout selected) {
        for (int i = 0; i < list.getChildCount(); i++) {
            View child = list.getChildAt(i);
            if (!(child instanceof LinearLayout row) || row.getChildCount() == 0
                    || !(row.getChildAt(0) instanceof TextView dot)) continue;
            boolean on = row == selected;
            row.setBackgroundColor(on ? 0xFFF4F9FF : 0xFFFFFFFF);
            dot.setText(on ? "◉" : "○");
            dot.setTextColor(on ? 0xFF0B6BD2 : 0xFF98A5B4);
        }
    }

    private void buildGatewayPanel(LinearLayout panel, String current, View screen) {
        sectionTitle(panel, "添加网关地址", null);
        LinearLayout inputCard = card(panel, 13);
        LinearLayout field = new LinearLayout(this);
        EditText address = setupInput("https://gateway.example.com");
        address.setText(activeP2p == null ? current : "");
        address.setContentDescription(getString(R.string.server_url));
        field.addView(address, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button add = setupButton("新增", false);
        LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(dp(64), dp(48));
        addParams.leftMargin = dp(8); field.addView(add, addParams);
        inputCard.addView(field);
        Button connect = setupButton("连接", true);
        inputCard.addView(connect, new LinearLayout.LayoutParams(-1, dp(48)));
        connect.setVisibility(address.length() == 0 ? View.GONE : View.VISIBLE);
        address.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                connect.setVisibility(s.length() == 0 ? View.GONE : View.VISIBLE);
            }
            public void afterTextChanged(android.text.Editable s) { }
        });
        addGap(panel, 17);
        String active = activeP2p != null || server == null ? "" : server.origin();
        java.util.List<String> saved = SavedServerAddresses.load(
                getPreferences(MODE_PRIVATE).getString(SERVER_LIST_KEY, ""), active);
        sectionTitle(panel, "已保存的地址", saved.size() + " 条");
        LinearLayout list = card(panel, 0);
        final String[] selected = {saved.isEmpty() ? null : saved.get(0)};
        for (String origin : saved) {
            Uri uri = Uri.parse(origin);
            LinearLayout row = connectionRow(uri.getHost() == null ? origin : uri.getHost(),
                    origin, origin.equals(active), origin.equals(selected[0]), list);
            row.setOnClickListener(v -> { selected[0] = origin; selectRows(list, row); });
            row.getChildAt(0).setOnClickListener(v -> { selected[0] = origin; selectRows(list, row); });
            TextView remove = label("×", 18, 0xFF8D98A7, false);
            remove.setGravity(Gravity.CENTER);
            remove.setContentDescription("删除 " + origin);
            row.addView(remove, new LinearLayout.LayoutParams(dp(44), dp(48)));
            remove.setOnClickListener(v -> {
                if (checking) return;
                boolean deletingActive = origin.equals(active);
                if (deletingActive) { completionWatches.clear(); stopCompletionWatchService(); server = null; }
                getPreferences(MODE_PRIVATE).edit()
                        .putString(SERVER_LIST_KEY, SavedServerAddresses.store(SavedServerAddresses.remove(saved, origin)))
                        .putString(SERVER_KEY, deletingActive ? "" : active).apply();
                showAddressScreen(deletingActive ? "" : active);
            });
        }
        if (saved.isEmpty()) {
            TextView empty = label("还没有保存的地址", 12, 0xFF8794A4, false);
            empty.setGravity(Gravity.CENTER);
            list.addView(empty, new LinearLayout.LayoutParams(-1, dp(58)));
        }
        Button switchAddress = setupButton("切换到所选连接", true);
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, dp(48));
        actionParams.setMargins(dp(12), dp(8), dp(12), dp(12));
        list.addView(switchAddress, actionParams);
        switchAddress.setEnabled(!saved.isEmpty());
        ProgressBar progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(36), dp(36));
        progressParams.gravity = Gravity.CENTER_HORIZONTAL;
        panel.addView(progress, progressParams);
        TextView error = label("", 12, 0xFFB3261E, false);
        panel.addView(error);
        add.setOnClickListener(v -> {
            if (checking) return;
            try {
                ServerAddress candidate = ServerAddress.parse(address.getText().toString());
                if (saved.contains(candidate.origin())) { error.setText(R.string.address_already_saved); return; }
                getPreferences(MODE_PRIVATE).edit().putString(SERVER_LIST_KEY,
                        SavedServerAddresses.store(SavedServerAddresses.add(saved, candidate.origin()))).apply();
                showAddressScreen(candidate.origin());
            } catch (IllegalArgumentException reason) { error.setText(R.string.invalid_server_address); }
        });
        connect.setOnClickListener(v -> {
            try { connectToServer(ServerAddress.parse(address.getText().toString()),
                    screen, connect, switchAddress, progress, error); }
            catch (IllegalArgumentException reason) { error.setText(R.string.invalid_server_address); }
        });
        switchAddress.setOnClickListener(v -> {
            if (selected[0] == null) { error.setText(R.string.select_address); return; }
            connectToServer(ServerAddress.parse(selected[0]), screen, connect, switchAddress, progress, error);
        });
    }

    private void saveP2p(String input, boolean connect) {
        try {
            P2pConnection item = P2pConnection.parse(input);
            java.util.List<P2pConnection> saved = p2pStore.load();
            saved.removeIf(entry -> entry.entryUrl().equals(item.entryUrl()));
            saved.add(item);
            p2pStore.save(saved);
            if (connect) connectP2p(item);
            else showAddressScreen("");
        } catch (IllegalArgumentException | IllegalStateException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void connectP2p(P2pConnection item) {
        completionWatches.clear();
        stopCompletionWatchService();
        activeP2p = item;
        server = item.server();
        getPreferences(MODE_PRIVATE).edit().putString(P2P_ACTIVE_KEY, item.entryUrl())
                .remove(SERVER_KEY).apply();
        showWebView();
    }

    private void connectToServer(ServerAddress candidate, View screen, Button connect,
                                 Button switchAddress, ProgressBar progress, TextView error) {
        if (checking) return;
        checking = true;
        connect.setEnabled(false);
        switchAddress.setEnabled(false);
        progress.setVisibility(View.VISIBLE);
        error.setText("");
        executor.execute(() -> {
            String failure = checkServer(candidate);
            runOnUiThread(() -> {
                checking = false;
                if (isFinishing() || isDestroyed() || root.getChildAt(0) != screen) return;
                connect.setEnabled(true);
                switchAddress.setEnabled(true);
                progress.setVisibility(View.GONE);
                if (failure != null) {
                    error.setText(failure);
                    return;
                }
                if (activeP2p != null || server == null || !server.origin().equals(candidate.origin())) {
                    completionWatches.clear();
                    stopCompletionWatchService();
                }
                server = candidate;
                activeP2p = null;
                java.util.List<String> saved = SavedServerAddresses.load(
                        getPreferences(MODE_PRIVATE).getString(SERVER_LIST_KEY, ""),
                        getPreferences(MODE_PRIVATE).getString(SERVER_KEY, ""));
                getPreferences(MODE_PRIVATE).edit()
                        .remove(P2P_ACTIVE_KEY)
                        .putString(SERVER_KEY, candidate.origin())
                        .putString(SERVER_LIST_KEY, SavedServerAddresses.store(
                                SavedServerAddresses.add(saved, candidate.origin()))).apply();
                showWebView();
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
            return getString(R.string.server_connection_failed, error.getLocalizedMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // The existing React application requires JavaScript.
    private void showWebView() {
        clearPage();
        gatewayLoginNavigation.reset();
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
            calendarHost = new CalendarHost(this);
            WebViewCompat.addWebMessageListener(view, "WorkStepCalendar",
                    Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                        if (source != webView || !isMainFrame || server == null || !server.contains(sourceOrigin.toString())) return;
                        calendarHost.handle(message.getData(), reply);
                    });
            systemSpeech = new SystemSpeech(this);
            WebViewCompat.addWebMessageListener(view, "WorkStepSpeech",
                    Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                        if (source != webView || !isMainFrame || server == null || !server.contains(sourceOrigin.toString())) return;
                        if (systemSpeech != null) systemSpeech.handle(message.getData(), reply);
                    });
            WebViewCompat.addWebMessageListener(view, "WorkStepWakeChime",
                    Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                        if (source != webView || !isMainFrame || server == null || !server.contains(sourceOrigin.toString())) return;
                        if (systemSpeech != null) systemSpeech.handleWakeChime(message.getData(), reply);
                    });
            WebViewCompat.addWebMessageListener(view, "WorkStepWakeGreeting",
                    Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                        if (source != webView || !isMainFrame || server == null || !server.contains(sourceOrigin.toString())) return;
                        if (systemSpeech != null) systemSpeech.handleWakeGreeting(message.getData(), reply);
                    });
            WebViewCompat.addWebMessageListener(view, "WorkStepAndroid",
                    Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                        if (source != webView || !isMainFrame || server == null || !server.contains(sourceOrigin.toString())) return;
                        handleNotificationMessage(message.getData());
                    });
            if (activeP2p != null) {
                WebViewCompat.addWebMessageListener(view, "WorkStepP2pDownload",
                        Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                            if (source != webView || !isMainFrame || activeP2p == null || server == null
                                    || !server.contains(sourceOrigin.toString()) || source.getUrl() == null
                                    || !source.getUrl().startsWith(activeP2p.entryUrl())) return;
                            p2pDownload.handle(message.getData(), reply);
                        });
                WebViewCompat.addWebMessageListener(view, "WorkStepP2p",
                        Collections.singleton(server.origin()), (source, message, sourceOrigin, isMainFrame, reply) -> {
                            if (source != webView || !isMainFrame || activeP2p == null
                                    || !server.contains(sourceOrigin.toString()) || !"settings".equals(message.getData())) return;
                            source.post(() -> {
                                if (source == webView) showAddressScreen(server.origin());
                            });
                        });
            }
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView source, String url, android.graphics.Bitmap icon) {
                if (source != webView) return;
                p2pDownload.cancel();
                showConnectionMenuOnTop();
                // The configured WorkStep page can start its capture graph on standby.
                source.getSettings().setMediaPlaybackRequiresUserGesture(server == null || !server.contains(url));
                runtimeDiagnostics.navigation();
                microphonePermissions.clear();
                if (systemSpeech != null) systemSpeech.stop();
                notificationProjectId = "";
                notificationProjectName = "";
                gatewayLoginNavigation.pageStarted(server, url);
                pageLoading = true;
                pageHadError = false;
                android.view.View errorPanel = root.findViewWithTag("connection_error");
                if (errorPanel != null) root.removeView(errorPanel);
                int generation = ++pageLoadGeneration;
                source.postDelayed(() -> {
                    if (source == webView && generation == pageLoadGeneration && pageLoading) {
                        CrashReports.log(MainActivity.this, "网页主进程", "网页加载超时；路径=" + Uri.parse(url).getPath(), null);
                        showWebError(getString(R.string.web_timeout));
                    }
                }, 180000);
            }

            @Override
            public void onPageFinished(WebView source, String url) {
                if (source != webView) return;
                pageLoading = false;
                String currentUrl = source.getUrl();
                if (!WebPageRecovery.needsRootCheck(server, currentUrl)) return;
                int generation = pageLoadGeneration;
                source.postDelayed(() -> {
                    if (source != webView || generation != pageLoadGeneration || pageHadError) return;
                    source.evaluateJavascript("(function(){var r=document.getElementById('root');return !!r&&r.childElementCount>0;})()", value -> {
                        if (source != webView || generation != pageLoadGeneration || pageHadError) return;
                        if ("false".equals(value)) {
                            CrashReports.log(MainActivity.this, "网页主进程", "网页渲染失败；根节点为空；路径=" + Uri.parse(url).getPath(), null);
                            showWebError(getString(R.string.web_render_failed));
                        }
                    });
                }, 3000);
            }

            @Override
            public void doUpdateVisitedHistory(WebView source, String url, boolean isReload) {
                if (source == webView) rememberPage(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String url = request.getUrl().toString();
                String localReturn = gatewayLoginNavigation.rewrittenLocalReturn(server, url);
                if (localReturn != null) {
                    CrashReports.log(MainActivity.this, "网页主进程",
                            "网关返回地址已转 HTTPS；路径=" + Uri.parse(url).getPath(), null);
                    source.loadUrl(localReturn);
                    return true;
                }
                if (gatewayLoginNavigation.staysInWebView(server, url)) return false;
                openExternal(url);
                return true;
            }

            @Override
            public void onReceivedError(WebView source, WebResourceRequest request, WebResourceError error) {
                if (source != webView) return;
                if (request.isForMainFrame() || isPageScript(request)) {
                    CrashReports.log(MainActivity.this, "网页主进程", "网页加载失败；错误码=" + error.getErrorCode()
                            + "；路径=" + request.getUrl().getPath(), null);
                    showWebError(getString(R.string.web_load_failed, error.getDescription()));
                }
            }

            @Override
            public void onReceivedHttpError(WebView source, WebResourceRequest request,
                    android.webkit.WebResourceResponse response) {
                if (source == webView && (request.isForMainFrame() || isPageScript(request))) {
                    CrashReports.log(MainActivity.this, "网页主进程", "网页资源加载失败；HTTP=" + response.getStatusCode()
                            + "；路径=" + request.getUrl().getPath(), null);
                    showWebError(getString(R.string.web_http_failed, response.getStatusCode()));
                }
            }

            @Override
            public void onReceivedSslError(WebView source, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (source == webView) {
                    CrashReports.log(MainActivity.this, "网页主进程", getString(R.string.web_tls_failed), null);
                    showWebError(getString(R.string.web_tls_failed));
                }
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
                microphonePermissions.clear();
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
            public void onPermissionRequest(PermissionRequest request) {
                microphonePermissions.request(view, request);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                microphonePermissions.cancelled(request);
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                if (view == webView && message.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) {
                    CrashReports.log(MainActivity.this, "网页主进程", "网页脚本错误；来源="
                            + WebPageRecovery.sourcePath(message.sourceId())
                            + "；行=" + message.lineNumber() + "；类型="
                            + WebPageRecovery.consoleSummary(message.message()), null);
                }
                return super.onConsoleMessage(message);
            }

            @Override
            public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    if (imageCapture != null) imageCapture.clear();
                    Intent picker = createFileChooserIntent(params);
                    if (FileChooserMode.isImageOnly(params.getAcceptTypes())) {
                        new android.app.AlertDialog.Builder(MainActivity.this)
                                .setTitle("增加图片")
                                .setItems(new String[]{"本地图片", "拍照"}, (dialog, which) -> {
                                    if (which == 0) openFilePicker(picker);
                                    else {
                                        imageCapture = new ImageCapture(MainActivity.this, FILE_REQUEST, () -> finishFileSelection(null));
                                        foregroundRefresh.externalPickerStarted();
                                        imageCapture.start();
                                    }
                                })
                                .setOnCancelListener(dialog -> finishFileSelection(null))
                                .show();
                    } else openFilePicker(picker);
                    return true;
                } catch (Exception error) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, getString(R.string.file_picker_failed), Toast.LENGTH_SHORT).show();
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
                        if (!request.isForMainFrame()) return false;
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
        pageLoading = true;
        view.loadUrl(activeP2p != null ? LastPageUrl.p2pLaunchUrl(activeP2p,
                getPreferences(MODE_PRIVATE).getString(P2P_PAGE_PREFIX + activeP2p.entryUrl(), null))
                : server.pageOrRoot(requestedPage != null ? requestedPage
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

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CalendarHost.PERMISSION_REQUEST) {
            getSharedPreferences("native_calendar", MODE_PRIVATE).edit().putBoolean("permission_asked", true).apply();
            if (calendarHost != null) calendarHost.permissionResult();
            return;
        }
        if (requestCode == ImageCapture.PERMISSION_REQUEST) {
            if (imageCapture != null) imageCapture.permissionResult(permissions, grantResults);
            return;
        }
        if (microphonePermissions != null) microphonePermissions.result(requestCode, permissions, grantResults);
    }

    private void rememberPage(String url) {
        if (activeP2p != null) {
            String detail = LastPageUrl.p2pDetail(activeP2p, url);
            if (detail != null)
                getPreferences(MODE_PRIVATE).edit().putString(P2P_PAGE_PREFIX + activeP2p.entryUrl(), detail).apply();
        } else if (LastPageUrl.shouldRemember(server, url)) {
            getPreferences(MODE_PRIVATE).edit().putString(PAGE_KEY, url).apply();
        }
    }

    private void handleNotificationMessage(String raw) {
        try {
            JSONObject message = new JSONObject(raw);
            String workspaceUrl = message.optString("workspaceUrl");
            if (server != null && workspaceUrl.startsWith("/workspace/")
                    && server.contains(server.origin() + workspaceUrl))
                message.put("url", workspaceUrl);
            String type = message.optString("type");
            if ("thought-history".equals(type)) {
                showConnectionMenuOnTop();
                return;
            }
            if ("project".equals(type)) {
                String projectId = message.optString("projectId");
                notificationProjectId = projectId;
                notificationProjectName = message.optString("projectName");
                completionWatches.entrySet().removeIf(entry ->
                        !projectId.equals(entry.getValue().optString("projectId")));
                return;
            }
            String id = message.optString("id");
            if (id.isEmpty()) return;
            if ("watch".equals(type)) {
                if (!message.optString("projectId").isEmpty()
                        && (!NotificationIds.value(message.optString("sessionId")).isEmpty() || !NotificationIds.value(message.optString("taskId")).isEmpty())) {
                    message.put("startedAt", System.currentTimeMillis());
                    completionWatches.put(id, message);
                    CrashReports.log(this, "网页主进程", "登记监听；数量=" + completionWatches.size(), null);
                }
            } else if ("unwatch".equals(type)) {
                completionWatches.remove(id);
                CrashReports.log(this, "网页主进程", "取消监听；数量=" + completionWatches.size(), null);
            } else if ("notify".equals(type)) {
                String target = message.optString("url");
                if (activityVisible && webView != null
                        && NotificationView.isCurrentDestination(webView.getUrl(), server.origin() + target,
                                server, notificationProjectId, notificationProjectName)) {
                    CrashReports.log(this, "网页主进程", "结果属于当前详情，未弹系统通知", null);
                    return;
                }
                String outcome = message.optString("outcome");
                if (!"succeeded".equals(outcome) && !"failed".equals(outcome)) return;
                boolean success = "succeeded".equals(outcome);
                boolean task = !NotificationIds.value(message.optString("taskId")).isEmpty();
                String stepKey = NotificationIds.value(message.optString("stepKey"));
                boolean step = !stepKey.isEmpty();
                JSONObject watch = completionWatches.get(id);
                String name = NotificationContent.bridgeName(message.optString("scopeName"),
                        watch == null ? "" : watch.optString("scopeName"),
                        NotificationIds.value(message.optString("sessionId")),
                        NotificationIds.value(message.optString("taskId")));
                String result = CompletionNotifications.show(this, id,
                        NotificationContent.title(name, step, success),
                        NotificationContent.body(name, task, stepKey, success),
                        target, server);
                CrashReports.log(this, "网页主进程",
                        "网页桥接系统通知：" + result + "；目标=" + target, null);
            }
        } catch (Exception error) {
            android.util.Log.e("WorkStep", "Notification bridge message failed", error);
            CrashReports.log(this, "网页主进程", "通知桥接失败", error);
        }
    }

    private void finishFileSelection(Uri[] files) {
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        if (callback != null) callback.onReceiveValue(files);
    }

    private void openFilePicker(Intent picker) {
        try {
            startActivityForResult(picker, FILE_REQUEST);
            foregroundRefresh.externalPickerStarted();
        } catch (Exception error) {
            finishFileSelection(null);
            Toast.makeText(this, getString(R.string.file_picker_failed), Toast.LENGTH_SHORT).show();
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
        button.setTag("connection_menu");
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

            menu.getMenu().add(R.string.keep_screen_on)
                    .setCheckable(true)
                    .setChecked(getPreferences(MODE_PRIVATE).getBoolean(KEEP_SCREEN_ON_KEY, true))
                    .setOnMenuItemClickListener(item -> {
                        boolean enabled = !item.isChecked();
                        getPreferences(MODE_PRIVATE).edit().putBoolean(KEEP_SCREEN_ON_KEY, enabled).apply();
                        updateKeepScreenOn();
                        return true;
                    });
            menu.getMenu().add(R.string.reload).setOnMenuItemClickListener(item -> {
                if (webView != null) webView.reload();
                return true;
            });
            menu.getMenu().add(R.string.clear_web_cache).setOnMenuItemClickListener(item -> {
                reloadWithoutCache();
                return true;
            });
            if (webView != null && WebPageRecovery.devicePicker(server, webView.getUrl()) != null) {
                menu.getMenu().add(R.string.return_to_devices).setOnMenuItemClickListener(item -> {
                    returnToDevices();
                    return true;
                });
            }
            menu.getMenu().add(R.string.runtime_diagnostics).setOnMenuItemClickListener(item -> {
                runtimeDiagnostics.open();
                return true;
            });
            menu.getMenu().add(R.string.test_notification).setOnMenuItemClickListener(item -> {
                String result = CompletionNotifications.show(this,
                        "test-" + SystemClock.elapsedRealtime(), "WorkStep 测试通知",
                        "如果能看到这条通知，系统通知权限正常", "/", server);
                CrashReports.log(this, "网页主进程", "测试通知：" + result, null);
                Toast.makeText(this, "已发送".equals(result) ? "已发送测试通知" : result, Toast.LENGTH_SHORT).show();
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

    private void showConnectionMenuOnTop() {
        View menu = root.findViewWithTag("connection_menu");
        if (menu != null) {
            menu.setVisibility(View.VISIBLE);
            menu.bringToFront();
        }
    }

    private void openNewWindowUrl(String url) {
        String localReturn = gatewayLoginNavigation.rewrittenLocalReturn(server, url);
        if (localReturn != null && webView != null) {
            CrashReports.log(this, "网页主进程", "网关返回地址已转 HTTPS；路径=" + Uri.parse(url).getPath(), null);
            webView.loadUrl(localReturn);
        }
        else if (gatewayLoginNavigation.staysInWebView(server, url) && webView != null) webView.loadUrl(url);
        else openExternal(url);
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                && !"mailto".equalsIgnoreCase(scheme) && !"tel".equalsIgnoreCase(scheme)) return;
        try {
            CrashReports.log(this, "网页主进程", "转系统浏览器；域名=" + uri.getHost(), null);
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(this, getString(R.string.external_link_failed), Toast.LENGTH_SHORT).show();
        }
    }

    private final DownloadListener downloadListener = (url, userAgent, disposition, mime, length) -> {
        if (server == null || !server.contains(url)) {
            Toast.makeText(this, getString(R.string.download_same_origin), Toast.LENGTH_SHORT).show();
            return;
        }
        if (pendingDownload != null) {
            Toast.makeText(this, getString(R.string.finish_current_save), Toast.LENGTH_SHORT).show();
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
            Toast.makeText(this, getString(R.string.save_picker_failed), Toast.LENGTH_LONG).show();
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
                        if (location == null) throw new IllegalStateException("The server did not provide a download location");
                        address = download.server.resolveSameOrigin(address, location);
                        continue;
                    }
                    if (status != 200) throw new IllegalStateException("The server returned HTTP " + status);
                    try (InputStream input = connection.getInputStream();
                         OutputStream output = getContentResolver().openOutputStream(document, "w")) {
                        if (output == null) throw new IllegalStateException("Could not write to the selected location");
                        byte[] buffer = new byte[16384];
                        int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    }
                    return null;
                } finally {
                    connection.disconnect();
                }
            }
            throw new IllegalStateException("Too many download redirects");
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
        pageLoading = false;
        pageHadError = true;
        if (root.findViewWithTag("connection_error") != null) {
            showConnectionMenuOnTop();
            return;
        }
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
        Button clearCache = new Button(this);
        clearCache.setText(R.string.clear_cache_reload);
        clearCache.setOnClickListener(view -> reloadWithoutCache());
        panel.addView(clearCache);
        if (webView != null && WebPageRecovery.devicePicker(server, webView.getUrl()) != null) {
            Button devices = new Button(this);
            devices.setText(R.string.return_to_devices);
            devices.setOnClickListener(view -> returnToDevices());
            panel.addView(devices);
        }
        Button logs = new Button(this);
        logs.setText(R.string.runtime_diagnostics);
        logs.setOnClickListener(view -> runtimeDiagnostics.open());
        panel.addView(logs);
        Button change = new Button(this);
        change.setText(R.string.change_address);
        change.setOnClickListener(view -> showAddressScreen(server.origin()));
        panel.addView(change);
        root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        showConnectionMenuOnTop();
    }

    private void reloadWithoutCache() {
        if (webView == null) return;
        // Keep CookieManager and WebStorage intact so recovery preserves authentication and settings.
        webView.clearCache(true);
        webView.reload();
        CrashReports.log(this, "网页主进程", "网页缓存已清除并重新加载", null);
        Toast.makeText(this, R.string.web_cache_cleared, Toast.LENGTH_SHORT).show();
    }

    private boolean canCapturePerformance() {
        String url = webView == null ? null : webView.getUrl();
        return url != null && server != null && server.contains(url) && !pageLoading && !pageHadError;
    }

    private void returnToDevices() {
        if (webView == null) return;
        String destination = WebPageRecovery.devicePicker(server, webView.getUrl());
        if (destination == null) return;
        webView.stopLoading();
        CrashReports.log(this, "网页主进程", "返回网关设备列表", null);
        webView.loadUrl(destination);
    }

    private boolean isPageScript(WebResourceRequest request) {
        String path = request.getUrl().getPath();
        return path != null && (path.endsWith(".js") || path.endsWith(".mjs"));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == P2pScanActivity.REQUEST) {
            if (resultCode == RESULT_OK && data != null)
                saveP2p(data.getStringExtra(P2pScanActivity.RESULT_LINK), true);
            return;
        }
        if (runtimeDiagnostics.activityResult(requestCode, resultCode, data)) return;
        if (apkInstaller.onActivityResult(requestCode)) return;
        if (requestCode == P2pDownload.REQUEST_CODE) {
            p2pDownload.onResult(resultCode, data);
            return;
        }
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
                        Toast.makeText(this, failure == null ? "文件已保存" : getString(R.string.file_save_failed, failure),
                                Toast.LENGTH_LONG).show();
                    });
                });
            }
            return;
        }
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            Uri[] captured = imageCapture == null ? null : imageCapture.result(resultCode == RESULT_OK);
            finishFileSelection(captured != null ? captured : selectedFiles(resultCode, data));
        }
    }

    @Override
    protected void onPause() {
        runtimeDiagnostics.stop("hidden", null);
        CrashReports.log(this, "网页主进程", "进入后台；监听数量=" + completionWatches.size(), null);
        startCompletionWatchService();
        activityVisible = false;
        updateKeepScreenOn();
        super.onPause();
    }

    @Override
    protected void onStop() {
        microphonePermissions.clear();
        CrashReports.log(this, "网页主进程", "页面停止；监听数量=" + completionWatches.size(), null);
        if (webView != null) rememberPage(webView.getUrl());
        foregroundRefresh.onStop(SystemClock.elapsedRealtime());
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityVisible = true;
        updateKeepScreenOn();
        CrashReports.log(this, "网页主进程", "返回前台；监听数量=" + completionWatches.size(), null);
        stopCompletionWatchService();
        CrashReports.showIfPresent(this);
        boolean reload = foregroundRefresh.onResume(SystemClock.elapsedRealtime());
        if (webView != null) {
            switch (WebViewResumeAction.choose(notificationPage(getIntent()) != null, pageLoading, reload)) {
                case NOTIFICATION -> openNotificationPage(getIntent());
                case RELOAD -> { pageLoading = true; webView.reload(); }
                case RESUME -> webView.evaluateJavascript("window.dispatchEvent(new Event('workstep:resume'))", null);
                case WAIT -> { }
            }
        }
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
        int generation = ++notificationNavigationGeneration;
        Uri target = Uri.parse(page);
        CrashReports.log(this, "网页主进程", "点击通知；目标=" + target.getPath()
                + "；项目=" + target.getQueryParameter("project")
                + "；任务=" + target.getQueryParameter("task")
                + "；会话=" + target.getQueryParameter("session"), null);
        if (!pageHadError && NotificationView.isCurrentDestination(webView.getUrl(), page, server,
                notificationProjectId, notificationProjectName)) {
            if (!pageLoading)
                webView.evaluateJavascript("window.dispatchEvent(new Event('workstep:resume'))", null);
            return;
        }
        if (!pageHadError && !pageLoading && webView.getUrl() != null && server.contains(webView.getUrl())) {
            WebView source = webView;
            int loadGeneration = pageLoadGeneration;
            source.evaluateJavascript("(()=>{const detail={url:" + JSONObject.quote(page)
                    + ",handled:false};window.dispatchEvent(new CustomEvent('workstep:open-notification',"
                    + "{detail}));return detail.handled===true})()", handled -> {
                if (source != webView || generation != notificationNavigationGeneration
                        || loadGeneration != pageLoadGeneration) return;
                CrashReports.log(this, "网页主进程", "通知页内导航；已接收=" + "true".equals(handled), null);
                if (!"true".equals(handled)) {
                    pageLoading = true;
                    source.loadUrl(page);
                }
            });
            return;
        }
        pageLoading = true;
        webView.loadUrl(page);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else if (webView != null && activeP2p != null) showAddressScreen(server.origin());
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        CrashReports.log(this, "网页主进程", "页面销毁；监听数量=" + completionWatches.size(), null);
        activityVisible = false;
        clearPage();
        apkInstaller.dispose();
        runtimeDiagnostics.destroy();
        p2pDownload.dispose();
        executor.shutdownNow();
        super.onDestroy();
    }
}
