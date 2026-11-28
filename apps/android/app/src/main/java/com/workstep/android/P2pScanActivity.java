package com.workstep.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.ResultPoint;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;

import java.util.List;

public final class P2pScanActivity extends Activity {
    static final int REQUEST = 1008;
    static final String RESULT_LINK = "p2p_link";
    private DecoratedBarcodeView scanner;
    private TextView status;
    private boolean finished;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.WHITE);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0x990E1828);
        root.setOnClickListener(v -> finish());
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(18), dp(10), dp(18), dp(28));
        android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
        background.setColor(Color.WHITE);
        background.setCornerRadii(new float[]{dp(22), dp(22), dp(22), dp(22), 0, 0, 0, 0});
        sheet.setBackground(background);
        sheet.setOnClickListener(v -> { });
        View handle = new View(this);
        android.graphics.drawable.GradientDrawable handleBackground = new android.graphics.drawable.GradientDrawable();
        handleBackground.setColor(0xFFD5DAE2);
        handleBackground.setCornerRadius(dp(4));
        handle.setBackground(handleBackground);
        LinearLayout.LayoutParams handleParams = new LinearLayout.LayoutParams(dp(35), dp(4));
        handleParams.gravity = Gravity.CENTER_HORIZONTAL;
        sheet.addView(handle, handleParams);
        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("扫码添加 P2P 设备");
        title.setTextColor(0xFF20242B);
        title.setTextSize(17);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        heading.addView(title, new LinearLayout.LayoutParams(0, dp(56), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        Button cancel = new Button(this);
        cancel.setText("取消");
        cancel.setAllCaps(false);
        cancel.setTextColor(0xFF1265C4);
        cancel.setBackgroundColor(Color.WHITE);
        cancel.setOnClickListener(v -> finish());
        heading.addView(cancel, new LinearLayout.LayoutParams(dp(64), dp(56)));
        sheet.addView(heading);
        scanner = new DecoratedBarcodeView(this);
        scanner.setStatusText("");
        scanner.setBackgroundColor(0xFF102E4E);
        LinearLayout.LayoutParams camera = new LinearLayout.LayoutParams(dp(210), dp(210));
        camera.gravity = Gravity.CENTER_HORIZONTAL;
        sheet.addView(scanner, camera);
        status = new TextView(this);
        status.setText("将 WorkStep 配对码放入取景框");
        status.setTextColor(0xFF718092);
        status.setTextSize(12);
        status.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hint = new LinearLayout.LayoutParams(-1, dp(48));
        hint.topMargin = dp(8);
        sheet.addView(status, hint);
        root.addView(sheet, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        setContentView(root);
        scanner.decodeSingle(new BarcodeCallback() {
            @Override public void barcodeResult(BarcodeResult result) {
                if (finished) return;
                finished = true;
                setResult(RESULT_OK, new Intent().putExtra(RESULT_LINK, result.getText()));
                finish();
            }
            @Override public void possibleResultPoints(List<ResultPoint> points) { }
        });
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 1 && (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED))
            status.setText("请在系统设置中允许相机访问");
        else if (code == 1) scanner.resume();
    }

    @Override protected void onResume() {
        super.onResume();
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanner.resume();
    }

    @Override protected void onPause() { scanner.pause(); super.onPause(); }
}
